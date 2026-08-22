import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { ParLevelRepository, StoreRepository, ProductRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { protectedProcedure, router } from '../trpc';

const listForStoreInput = z.object({ storeId: z.string().uuid() });

const setInput = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
  parLevel: z.string().optional(),
  reorderPoint: z.string().optional(),
});

/**
 * The write path `ParLevelRepository.setParLevel` (earlier work) never had a tRPC procedure — the
 * onboarding wizard's "set par levels" step is its first real caller. Same two-layer store-ownership
 * check every other store-scoped procedure in this codebase uses (`StoreRepository.findById` first,
 * `canAccessStore` second — `canAccessStore` alone accepts any org's storeId for a `storeIds: 'ALL'`
 * caller, see stores.ts's own doc comment for why both layers are load-bearing).
 */
export const parLevelsRouter = router({
  listForStore: protectedProcedure.input(listForStoreInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, store.id)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const parLevelRepository = new ParLevelRepository(ctx.db, ctx.session.organizationId);
    return parLevelRepository.findAllForStore(input.storeId);
  }),

  set: protectedProcedure.input(setInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, store.id)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const product = await productRepository.findById(input.productId);
    if (!product) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'productId does not refer to a real product.' });
    }

    const parLevelRepository = new ParLevelRepository(ctx.db, ctx.session.organizationId);
    return parLevelRepository.setParLevel({
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId,
      ...(input.parLevel !== undefined ? { parLevel: input.parLevel } : {}),
      ...(input.reorderPoint !== undefined ? { reorderPoint: input.reorderPoint } : {}),
    });
  }),
});
