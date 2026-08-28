import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { money, generatePurchaseOrderPdf, type CurrencyCode } from '@retailos/domain';
import { canApproveAmount, canAccessStore, type AuthContext, type Permission } from '@retailos/authz';
import { createMockPoEmailSender } from '@retailos/email';
import {
  MembershipRepository,
  PurchaseOrderRepository,
  StoreRepository,
  SupplierRepository,
  findReorderSuggestions,
  organizations,
} from '@retailos/db';
import { eq } from 'drizzle-orm';
import {
  buildPurchaseOrderPdfKey,
  createPresignedDownloadUrl,
  ensureBucketExists,
  putObjectBytes,
} from '@retailos/storage';
import { protectedProcedure, router } from '../trpc';
import { storageClient, PURCHASE_ORDER_PDFS_BUCKET } from '../context';
import type { db as Db } from '../context';

/**
 * the same mocked transport for every `send` call in this process — matches this project's
 * "mock only the transport, keep the real code path real" precedent from Postmark inbound.
 * `onSend` is a no-op here (the caller persists the outcome via `recordSent` instead of relying on
 * this hook); a dedicated test constructs its own sender with a real `onSend` to assert on.
 */
const poEmailSender = createMockPoEmailSender();

/** Idempotent, matching `documents.ts`'s own `ensureBucketOnce` precedent — a separate bucket needing its own one-time creation. */
let pdfBucketEnsured = false;
const ensurePdfBucketOnce = async () => {
  if (pdfBucketEnsured) return;
  await ensureBucketExists(storageClient, PURCHASE_ORDER_PDFS_BUCKET);
  pdfBucketEnsured = true;
};

const suggestionsInput = z.object({ storeId: z.string().uuid() });

const PO_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
] as const;

const listInput = z.object({
  storeId: z.string().uuid(),
  status: z.enum(PO_STATUSES).optional(),
  supplierId: z.string().uuid().optional(),
  /** Keyset cursor: the last PO id the caller saw (UUID v7 — time-ordered), never a page OFFSET. */
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
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
 * the first real caller of `canApproveAmount` (`packages/authz`, built ahead of any
 * consumer since a later milestone/004) — the design's "PO approval up to a configured threshold."
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
 * `purchase_orders`/`purchase_order_lines`' first real HTTP surface — create/addLine
 * (DRAFT-only editing, per `PurchaseOrderRepository.addLine`'s own state check), `get` (PO + its
 * lines + real total), and the full state-machine mutation surface (submit/approve/reject/send/
 * cancel), each a thin wrapper over `PurchaseOrderRepository.applyTransition`. `approve` is the
 * one mutation with a real business check beyond the state machine: the approval-threshold gate
 * (`assertCanApprove`), the design
 */
export const purchaseOrdersRouter = router({
  reorderSuggestions: protectedProcedure.input(suggestionsInput).query(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    return findReorderSuggestions(ctx.db, ctx.session.organizationId, input.storeId);
  }),

  /** The purchasing front door: newest-first PO list, filterable by status/supplier, keyset-paginated. */
  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    const purchaseOrderRepository = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    return purchaseOrderRepository.listForStore({
      storeId: input.storeId,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      limit: input.limit,
    });
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

  /**
   * the design, "SENT triggers PDF generation + email to the supplier contact." The
   * state transition itself (immutability boundary) happens first and is authoritative regardless
   * of what follows — matching `recordSent`'s own doc comment: a PDF/email failure after a genuine
   * SEND must not leave the PO stuck in a half-transitioned state, since the design's optimistic
   * lock has already been consumed by a real, valid transition. `contactEmail === null` (no
   * confirmed supplier contact on file) is a real, visible failure — I7: this project never
   * silently treats "no email to send to" as "sent successfully."
   */
  send: protectedProcedure.input(transitionInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    const result = await repo.applyTransition(input.purchaseOrderId, 'SEND', input.expectedVersion, ctx.session.userId);
    if (!result.ok) {
      throw new TRPCError({ code: result.reason.includes('not found') ? 'NOT_FOUND' : 'CONFLICT', message: result.reason });
    }

    const pdfInput = await repo.buildPdfInput(input.purchaseOrderId);
    if (!pdfInput) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Purchase order was sent, but its PDF could not be generated (order not found on re-read).' });
    }
    if (pdfInput.supplier.contactEmail === null) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Purchase order was sent, but this supplier has no contact email on file — add one before it can be emailed.',
      });
    }

    const pdfBytes = await generatePurchaseOrderPdf(pdfInput);
    await ensurePdfBucketOnce();
    const pdfKey = buildPurchaseOrderPdfKey(ctx.session.organizationId, input.purchaseOrderId);
    await putObjectBytes(storageClient, PURCHASE_ORDER_PDFS_BUCKET, pdfKey, Buffer.from(pdfBytes), 'application/pdf');

    const emailResult = await poEmailSender.send({
      to: pdfInput.supplier.contactEmail,
      subject: `Purchase Order ${pdfInput.poNumber}`,
      bodyText: `Please find attached Purchase Order ${pdfInput.poNumber}.`,
      attachment: { filename: `${pdfInput.poNumber}.pdf`, contentType: 'application/pdf', bytes: pdfBytes },
    });
    if (!emailResult.ok) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Purchase order was sent and its PDF generated, but the email failed: ${emailResult.error}` });
    }

    await repo.recordSent(input.purchaseOrderId, pdfKey, pdfInput.supplier.contactEmail);

    return result;
  }),

  getPdfUrl: protectedProcedure.input(getInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:read');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    const purchaseOrder = await repo.findById(input.purchaseOrderId);
    if (!purchaseOrder) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase order not found.' });
    }
    if (purchaseOrder.pdfObjectKey === null) {
      return { url: null };
    }
    const url = await createPresignedDownloadUrl(storageClient, PURCHASE_ORDER_PDFS_BUCKET, purchaseOrder.pdfObjectKey);
    return { url };
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

  /**
   * The real exit for a supplier that short-ships and never delivers the remaining balance — the
   * one purchasing outcome the state machine previously had no way out of short of a manual DB
   * fix (`po-lifecycle.ts`'s own doc comment has the full reasoning). Deliberately NOT `cancel`:
   * real goods already arrived and were posted as real stock via a prior RECEIVE_PARTIAL, so
   * "cancelled" would misdescribe an order that partly, genuinely happened.
   */
  closeShort: protectedProcedure.input(rejectOrCancelInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    const repo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
    const result = await repo.applyTransition(input.purchaseOrderId, 'CLOSE_SHORT', input.expectedVersion, ctx.session.userId, input.reason);
    if (!result.ok) {
      throw new TRPCError({ code: result.reason.includes('not found') ? 'NOT_FOUND' : 'CONFLICT', message: result.reason });
    }
    return result;
  }),
});
