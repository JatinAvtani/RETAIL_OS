import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  LotRepository,
  MovementService,
  ProductRepository,
  StockLevelRepository,
  StockMovementRepository,
  StoreRepository,
  UnitRepository,
  InsufficientStockError,
  type WasteReasonCode,
} from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import type { Unit } from '@retailos/domain';
import { protectedProcedure, router } from '../trpc';
import type { db as Db } from '../context';

const storeScopedInput = z.object({ storeId: z.string().uuid() });

const productVariantInput = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
});

const lotDetailInput = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
});

const wasteReasonCodes = [
  'EXPIRED',
  'DAMAGED',
  'PREP_ERROR',
  'CUSTOMER_RETURN',
  'OVERPRODUCTION',
  'SPILLAGE',
  'QUALITY_REJECT',
  'THEFT_SUSPECTED',
] as const satisfies readonly WasteReasonCode[];

const logWasteInput = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: z.string(),
  reasonCode: z.enum(wasteReasonCodes),
  notes: z.string().optional(),
});

const logWasteFromLotInput = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
  lotId: z.string().uuid(),
  quantity: z.string(),
  reasonCode: z.enum(wasteReasonCodes),
  notes: z.string().optional(),
});

/**
 * Throws NOT_FOUND (never FORBIDDEN — spec 14 §14.3: a 403 confirms the resource exists) for a
 * store that either doesn't belong to the caller's org at all, OR belongs to the org but is
 * outside the caller's `storeIds` — matching `stores.get`'s exact two-layer convention.
 *
 * `canAccessStore` alone is NOT sufficient here — it only ever checks `ctx.storeIds`, and an
 * OWNER/MANAGER session's `storeIds` is commonly `'ALL'` (spec: "no store restriction
 * configured"), which trivially accepts ANY storeId string, including one from a completely
 * different organization. The real cross-org boundary comes from actually looking the store up
 * scoped to `organizationId` first (via `StoreRepository`, which extends `TenantScopedRepository`
 * and ANDs the org predicate into its query) — a cross-tenant.test.ts run against this router's
 * FIRST draft (assertStoreAccess doing only the canAccessStore check, no real lookup) proved this
 * gap directly: tenant B's session, storeIds: 'ALL', got a genuine 200 back for tenant A's real
 * storeId, an empty-but-real query result rather than a rejection.
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

/**
 * 005-16: the first real HTTP surface for ANY of EPIC-005's inventory data. Every procedure is
 * store-scoped, not just org-scoped — `assertStoreAccess` layers the same object-level check
 * `stores.get`/`stores.list` already established (spec 14 §14.3 rule 2) on top of the org-level
 * RLS/repository-guard scoping every `TenantScopedRepository` already gets, since a Manager
 * confined to one store must not see another store's inventory even within the same org.
 */
export const inventoryRouter = router({
  /** plan.md Phase 7: "stock levels with drill to movements" — this is the overview half. */
  levels: protectedProcedure.input(storeScopedInput).query(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.session.organizationId);
    return stockLevelRepository.findAllForStore(input.storeId);
  }),

  /** The drill-down half of "stock levels with drill to movements" — every ledger row for one product/variant at this store, most recent first. */
  movements: protectedProcedure.input(productVariantInput).query(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    const stockMovementRepository = new StockMovementRepository(ctx.db, ctx.session.organizationId);
    return stockMovementRepository.findByStoreAndVariant(input.storeId, input.variantId);
  }),

  /** plan.md Phase 7: "lot detail with expiry" — every lot (any status) for one product at this store, ordered the same way FEFO would draw them. */
  lots: protectedProcedure.input(lotDetailInput).query(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    const lotRepository = new LotRepository(ctx.db, ctx.session.organizationId);
    return lotRepository.findAllForProduct(input.storeId, input.productId);
  }),

  /** plan.md Phase 7: "waste entry (3 taps, mobile)" — FEFO-default path, `MovementService.logWaste`. */
  logWaste: protectedProcedure.input(logWasteInput).mutation(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);

    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const product = await productRepository.findById(input.productId);
    if (!product) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
    }
    const unitRepository = new UnitRepository(ctx.db);
    const unit = await unitRepository.findAll().then((units) => units.find((u) => u.id === product.baseUnitId));
    if (!unit) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Product has no resolvable base unit.' });
    }

    const movementService = new MovementService(ctx.db, ctx.session.organizationId);
    try {
      return await movementService.logWaste({
        storeId: input.storeId,
        productId: input.productId,
        variantId: input.variantId,
        quantity: input.quantity,
        unit: unit.code as Unit,
        reasonCode: input.reasonCode,
        occurredAt: new Date(),
        sourceType: 'manual',
        actorUserId: ctx.session.userId,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Not enough stock to log this waste — short by ${err.shortfall} ${err.unit}.`,
        });
      }
      throw err;
    }
  }),

  /** Waste logging's override path (spec 05 §5.1.5): staff specifies the exact lot rather than letting FEFO pick. */
  logWasteFromLot: protectedProcedure.input(logWasteFromLotInput).mutation(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);

    const movementService = new MovementService(ctx.db, ctx.session.organizationId);
    try {
      return await movementService.logWasteFromLot({
        storeId: input.storeId,
        productId: input.productId,
        variantId: input.variantId,
        lotId: input.lotId,
        quantity: input.quantity,
        reasonCode: input.reasonCode,
        occurredAt: new Date(),
        sourceType: 'manual',
        actorUserId: ctx.session.userId,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot waste more than this lot's remaining quantity — short by ${err.shortfall} ${err.unit}.`,
        });
      }
      throw err;
    }
  }),
});
