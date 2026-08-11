import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { money, type CurrencyCode } from '@retailos/domain';
import { canApproveAmount, canAccessStore, type AuthContext, type Permission } from '@retailos/authz';
import {
  MembershipRepository,
  PurchaseOrderRepository,
  StoreRepository,
  SupplierRepository,
  findReorderSuggestions,
  organizations,
} from '@retailos/db';
import { eq } from 'drizzle-orm';
import { protectedProcedure, router } from '../trpc';
import type { db as Db } from '../context';

const suggestionsInput = z.object({ storeId: z.string().uuid() });
const createInput = z.object({
  storeId: z.string().uuid(),
  supplierId: z.string().uuid(),
  poNumber: z.string().trim().min(1).max(100),
  expectedDeliveryDate: z.string().datetime().optional(),
  notes: z.string().trim().max(2000).optional(),
});
const addLineInput = z.object({
  purchaseOrderId: z.string().uuid(),
  supplierProductId: z.string().uuid(),
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantityOrderUnits: z.string(),
  orderUnitId: z.string().uuid().optional(),
  conversionToBase: z.string(),
  baseUnitId: z.string().uuid().optional(),
  unitPrice: z.string(),
  lineNumber: z.number().int().min(1),
});
const getInput = z.object({ purchaseOrderId: z.string().uuid() });
const transitionInput = z.object({ purchaseOrderId: z.string().uuid(), expectedVersion: z.number().int().min(1) });
const rejectOrCancelInput = transitionInput.extend({ reason: z.string().trim().max(1000).optional() });

/**
 * Same fix as `inventory.ts`/`stocktake.ts`'s own `assertStoreAccess` — `canAccessStore` alone
 * checks only `ctx.session.storeIds`, which is blind to organization when it's `'ALL'` (the common
 * OWNER/MANAGER case), trivially accepting ANY storeId string including one from a different org.
 * A real `StoreRepository.findById` lookup, scoped to `organizationId`, must run first.
 */
const assertStoreAccess = async (
  db: typeof Db,
  session: { organizationId: string; storeIds: string[] | 'ALL' },
  storeId: string
) => {
  const storeRepository = new StoreRepository(db, session.organizationId);
  const store = await storeRepository.findById(storeId);
  if (!store || !canAccessStore(session, storeId)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
  }
};

/** Same plain-array-check shape `documents.ts`'s own `requirePermission` established. */
const requirePermission = (permissions: string[], permission: string) => {
  if (!permissions.includes(permission)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  }
};

/** A supplier must belong to the SAME org as the caller — a bare id-shaped input with no separate assertSupplierAccess would let one org's PO reference another org's supplier row (assuming SupplierRepository's own tenant scoping caught it at read time, but the caller needs an explicit 404, not a silent empty result). */
const assertSupplierExists = async (db: typeof Db, organizationId: string, supplierId: string) => {
  const supplierRepository = new SupplierRepository(db, organizationId);
  const supplier = await supplierRepository.findById(supplierId);
  if (!supplier) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Supplier not found.' });
  }
};

/**
 * 008-05: the first real caller of `canApproveAmount` (`packages/authz`, built ahead of any
 * consumer since EPIC-003/004) — spec 04 §4.3's "PO approval up to a configured threshold."
 * Deliberately reads the CURRENT `approvalLimit` fresh from `memberships` at approval time via
 * `MembershipRepository.findByUserAndOrg`, never a value cached on the session at login — a
 * manager's limit can change after they logged in, and `ctx.session` doesn't carry it at all
 * (see `trpc.ts`'s own comment on why: "deferred until an endpoint actually needs
 * `canApproveAmount`; nothing does yet" — this is that endpoint).
 */
const assertCanApprove = async (
  db: typeof Db,
  session: { userId: string; organizationId: string; permissions: string[] },
  totalCents: string | null
) => {
  const membershipRepository = new MembershipRepository(db);
  const membership = await membershipRepository.findByUserAndOrg(session.userId, session.organizationId);
  if (!membership) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  }

  const [orgRow] = await db.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, session.organizationId));
  const currency = (orgRow?.baseCurrency ?? 'USD') as CurrencyCode;

  const authCtx: AuthContext = {
    userId: session.userId,
    organizationId: session.organizationId,
    storeIds: 'ALL',
    role: membership.role,
    permissions: new Set(session.permissions as Permission[]),
    ...(membership.approvalLimit !== null ? { approvalLimit: money(membership.approvalLimit, currency) } : {}),
  };

  // A PO with zero lines has no real total yet (I7 — getTotal returns null, never a fabricated
  // 0) — approving an empty order is nonsensical regardless of threshold, so it's rejected the
  // same as a real over-threshold amount rather than trivially clearing any limit.
  if (totalCents === null) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This purchase order has no lines yet — add at least one line before approving.' });
  }

  if (!canApproveAmount(authCtx, money(totalCents, currency))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This purchase order exceeds your approval limit.' });
  }
};

/**
 * 008-05: `purchase_orders`/`purchase_order_lines`' first real HTTP surface — create/addLine
 * (DRAFT-only editing, per `PurchaseOrderRepository.addLine`'s own state check), `get` (PO + its
 * lines + real total), and the full state-machine mutation surface (submit/approve/reject/send/
 * cancel), each a thin wrapper over `PurchaseOrderRepository.applyTransition`. `approve` is the
 * one mutation with a real business check beyond the state machine: the approval-threshold gate
 * (`assertCanApprove`), spec 04 §4.3.
 */
export const purchaseOrdersRouter = router({
  reorderSuggestions: protectedProcedure.input(suggestionsInput).query(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    return findReorderSuggestions(ctx.db, ctx.session.organizationId, input.storeId);
  }),

  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    await assertSupplierExists(ctx.db, ctx.session.organizationId, input.supplierId);

    const [orgRow] = await ctx.db.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, ctx.session.organizationId));
    const currency = orgRow?.baseCurrency ?? 'USD';

    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    return repo.create({
      storeId: input.storeId,
      supplierId: input.supplierId,
      poNumber: input.poNumber,
      currency,
      ...(input.expectedDeliveryDate !== undefined ? { expectedDeliveryDate: new Date(input.expectedDeliveryDate) } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      createdByUserId: ctx.session.userId,
    });
  }),

  addLine: protectedProcedure.input(addLineInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    const result = await repo.addLine({
      purchaseOrderId: input.purchaseOrderId,
      supplierProductId: input.supplierProductId,
      productId: input.productId,
      quantityOrderUnits: input.quantityOrderUnits,
      conversionToBase: input.conversionToBase,
      unitPrice: input.unitPrice,
      lineNumber: input.lineNumber,
      ...(input.variantId !== undefined ? { variantId: input.variantId } : {}),
      ...(input.orderUnitId !== undefined ? { orderUnitId: input.orderUnitId } : {}),
      ...(input.baseUnitId !== undefined ? { baseUnitId: input.baseUnitId } : {}),
    });
    if (!result.ok) {
      if (result.reason === 'NOT_FOUND') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase order not found.' });
      }
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This purchase order can no longer be edited.' });
    }
    return { id: result.id };
  }),

  get: protectedProcedure.input(getInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:read');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    const purchaseOrder = await repo.findById(input.purchaseOrderId);
    if (!purchaseOrder) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase order not found.' });
    }
    const [lines, total] = await Promise.all([repo.findLines(input.purchaseOrderId), repo.getTotal(input.purchaseOrderId)]);
    return { purchaseOrder, lines, total };
  }),

  submit: protectedProcedure.input(transitionInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    const result = await repo.applyTransition(input.purchaseOrderId, 'SUBMIT', input.expectedVersion, ctx.session.userId);
    if (!result.ok) {
      throw new TRPCError({ code: result.reason.includes('not found') ? 'NOT_FOUND' : 'CONFLICT', message: result.reason });
    }
    return result;
  }),

  approve: protectedProcedure.input(transitionInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:approve');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);

    const purchaseOrder = await repo.findById(input.purchaseOrderId);
    if (!purchaseOrder) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase order not found.' });
    }
    const total = await repo.getTotal(input.purchaseOrderId);
    await assertCanApprove(ctx.db, ctx.session, total);

    const result = await repo.applyTransition(input.purchaseOrderId, 'APPROVE', input.expectedVersion, ctx.session.userId);
    if (!result.ok) {
      throw new TRPCError({ code: result.reason.includes('not found') ? 'NOT_FOUND' : 'CONFLICT', message: result.reason });
    }
    return result;
  }),

  reject: protectedProcedure.input(rejectOrCancelInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:approve');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    const result = await repo.applyTransition(input.purchaseOrderId, 'REJECT', input.expectedVersion, ctx.session.userId, input.reason);
    if (!result.ok) {
      throw new TRPCError({ code: result.reason.includes('not found') ? 'NOT_FOUND' : 'CONFLICT', message: result.reason });
    }
    return result;
  }),

  send: protectedProcedure.input(transitionInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    const result = await repo.applyTransition(input.purchaseOrderId, 'SEND', input.expectedVersion, ctx.session.userId);
    if (!result.ok) {
      throw new TRPCError({ code: result.reason.includes('not found') ? 'NOT_FOUND' : 'CONFLICT', message: result.reason });
    }
    return result;
  }),

  cancel: protectedProcedure.input(rejectOrCancelInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    const result = await repo.applyTransition(input.purchaseOrderId, 'CANCEL', input.expectedVersion, ctx.session.userId, input.reason);
    if (!result.ok) {
      throw new TRPCError({ code: result.reason.includes('not found') ? 'NOT_FOUND' : 'CONFLICT', message: result.reason });
    }
    return result;
  }),
});
