import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  StockCountService,
  StoreRepository,
  EmptyCountScopeError,
  InvalidStockCountTransitionError,
  MissingVarianceReasonError,
  UnknownCostSurplusError,
} from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { protectedProcedure, router } from '../trpc';
import type { db as Db } from '../context';

/**
 * Same fix as `inventory.ts`'s `assertStoreAccess` — `canAccessStore` alone accepts ANY storeId
 * when the caller's `storeIds` is `'ALL'` (the common OWNER/MANAGER-with-no-restriction case),
 * regardless of which org that store actually belongs to. A real DB lookup scoped to
 * `organizationId` (via `StoreRepository`) is required to catch a cross-org storeId, matching
 * `stores.get`'s own two-layer convention.
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
 * `StockCountService`'s not-found paths (start/enterCount/submit/approve/reject/setLineReason,
 * called with a stockCountId/stockCountLineId that doesn't exist in this org) throw a plain
 * `Error('... not found.')`, not a typed error class the way `InvalidStockCountTransitionError`/
 * `MissingVarianceReasonError`/`UnknownCostSurplusError` are — a real gap `cross-tenant.test.ts`
 * caught directly: tenant B calling e.g. `stocktake.start` with tenant A's stockCountId fell
 * through every router catch block as an unhandled 500, not a 404. Mapped by message pattern
 * rather than adding a new typed error class to packages/db for this alone, since every one of
 * these methods already follows the identical "`'<entity>' not found`" message convention.
 */
const isNotFoundError = (err: unknown): boolean => err instanceof Error && /not found/i.test(err.message);

const createFullInput = z.object({
  storeId: z.string().uuid(),
  productVariantPairs: z.array(z.object({ productId: z.string().uuid(), variantId: z.string().uuid() })).min(1),
});
const createByCategoryInput = z.object({ storeId: z.string().uuid(), categoryId: z.string().uuid() });
const createByStorageLocationInput = z.object({ storeId: z.string().uuid(), storageLocationId: z.string().uuid() });
const countIdInput = z.object({ stockCountId: z.string().uuid() });
const enterCountInput = z.object({ stockCountLineId: z.string().uuid(), countedQuantity: z.string() });

/**
 * the state machine related work built (`DRAFT → IN_PROGRESS → SUBMITTED → APPROVED |
 * REJECTED`) gets its first real HTTP surface. `get`'s sheet is ordered by physical storage
 * location per the plan Phase 7 ("the person counting walks the room") — the whole reason
 * `findLinesOrderedByStorageLocation` exists as a distinct method from the already-present
 * `findLines`, which returns lines in no particular guaranteed order.
 *
 * `storeId` is required on every count-creation/lookup path the same way `inventory.ts` requires
 * it — a count belongs to one store, and object-level store scoping applies here exactly as it
 * does to every other a later milestone endpoint. Lookups by `stockCountId` alone (start/enter/submit/
 * approve/reject) don't re-verify `storeId` from the request, since `StockCountService` itself is
 * already org-scoped via RLS/the repository guard and a count's `storeId` is fixed at creation —
 * there is no cross-store id to spoof once the count exists, only cross-org, which RLS/the
 * repository's `organizationId` predicate already blocks.
 */
export const stocktakeRouter = router({
  createFull: protectedProcedure.input(createFullInput).mutation(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    const service = new StockCountService(ctx.db, ctx.session.organizationId);
    return service.createCount({
      storeId: input.storeId,
      scope: 'full',
      productVariantPairs: input.productVariantPairs,
      createdByUserId: ctx.session.userId,
    });
  }),

  createByCategory: protectedProcedure.input(createByCategoryInput).mutation(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    const service = new StockCountService(ctx.db, ctx.session.organizationId);
    try {
      return await service.createCountByCategory({
        storeId: input.storeId,
        categoryId: input.categoryId,
        createdByUserId: ctx.session.userId,
      });
    } catch (err) {
      if (err instanceof EmptyCountScopeError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      throw err;
    }
  }),

  createByStorageLocation: protectedProcedure.input(createByStorageLocationInput).mutation(async ({ ctx, input }) => {
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    const service = new StockCountService(ctx.db, ctx.session.organizationId);
    try {
      return await service.createCountByStorageLocation({
        storeId: input.storeId,
        storageLocationId: input.storageLocationId,
        createdByUserId: ctx.session.userId,
      });
    } catch (err) {
      if (err instanceof EmptyCountScopeError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      throw err;
    }
  }),

  /** The full count + its lines, lines ordered by physical storage location — the actual "stocktake sheet" a counter reads from. */
  get: protectedProcedure.input(countIdInput).query(async ({ ctx, input }) => {
    const service = new StockCountService(ctx.db, ctx.session.organizationId);
    const count = await service.findById(input.stockCountId);
    if (!count) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock count not found.' });
    }
    const lines = await service.findLinesOrderedByStorageLocation(input.stockCountId);
    return { count, lines };
  }),

  start: protectedProcedure.input(countIdInput).mutation(async ({ ctx, input }) => {
    const service = new StockCountService(ctx.db, ctx.session.organizationId);
    try {
      return await service.startCount(input.stockCountId);
    } catch (err) {
      if (err instanceof InvalidStockCountTransitionError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      if (isNotFoundError(err)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock count not found.' });
      }
      throw err;
    }
  }),

  enterCount: protectedProcedure.input(enterCountInput).mutation(async ({ ctx, input }) => {
    const service = new StockCountService(ctx.db, ctx.session.organizationId);
    try {
      return await service.enterCount(input.stockCountLineId, input.countedQuantity, ctx.session.userId);
    } catch (err) {
      if (isNotFoundError(err)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock count line not found.' });
      }
      throw err;
    }
  }),

  submit: protectedProcedure.input(countIdInput).mutation(async ({ ctx, input }) => {
    const service = new StockCountService(ctx.db, ctx.session.organizationId);
    try {
      return await service.submitCount(input.stockCountId, ctx.session.userId);
    } catch (err) {
      if (err instanceof InvalidStockCountTransitionError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      if (isNotFoundError(err)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock count not found.' });
      }
      throw err;
    }
  }),

  approve: protectedProcedure.input(countIdInput).mutation(async ({ ctx, input }) => {
    const service = new StockCountService(ctx.db, ctx.session.organizationId);
    try {
      return await service.approveCount(input.stockCountId, ctx.session.userId);
    } catch (err) {
      if (err instanceof InvalidStockCountTransitionError || err instanceof MissingVarianceReasonError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      if (err instanceof UnknownCostSurplusError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      if (isNotFoundError(err)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock count not found.' });
      }
      throw err;
    }
  }),

  reject: protectedProcedure.input(countIdInput).mutation(async ({ ctx, input }) => {
    const service = new StockCountService(ctx.db, ctx.session.organizationId);
    try {
      return await service.rejectCount(input.stockCountId, ctx.session.userId);
    } catch (err) {
      if (err instanceof InvalidStockCountTransitionError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      if (isNotFoundError(err)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock count not found.' });
      }
      throw err;
    }
  }),

  /** A reason code on a line with a large unexplained variance — separate from `enterCount` since a reason is optional unless the variance magnitude actually requires one (enforced at `approve`, not here). The only way `approveCount`'s `MissingVarianceReasonError` path can ever be satisfied for a real count. */
  setLineReason: protectedProcedure
    .input(z.object({ stockCountLineId: z.string().uuid(), reasonCode: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const service = new StockCountService(ctx.db, ctx.session.organizationId);
      try {
        return await service.setLineReason(input.stockCountLineId, input.reasonCode);
      } catch (err) {
        if (isNotFoundError(err)) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Stock count line not found.' });
        }
        throw err;
      }
    }),
});
