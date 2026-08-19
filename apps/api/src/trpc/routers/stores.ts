import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { StoreRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { protectedProcedure, router } from '../trpc';

const getInput = z.object({
  id: z.string().uuid(),
});

/**
 * The first endpoint proving object-level store scoping:
 * `memberships.store_ids` restricts a caller to specific stores within their own org, a check
 * that's separate from — and layered on top of — the org-level RLS/repository-guard scoping every
 * other endpoint already has. Deliberately gated on nothing but a valid session, not a Permission:
 * seeing which stores exist (name/timezone/address/status) isn't sensitive the way inventory or
 * financial data is, and VIEWER_FINANCE (no `inventory:*` permission) still needs to see stores to
 * audit them. The real boundary here is *which* stores a caller can see, not whether they can see
 * stores at all.
 */
export const storesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const allOrgStores = await storeRepository.findAll();

    return allOrgStores.filter((store) => canAccessStore(ctx.session, store.id));
  }),

  /**
   * 404, not 403, for both a wrong-org store (RLS/repository guard already returns null — the org
   * boundary) and a right-org-wrong-store one (the new object-level check below) — the design:
   * a 403 confirms the resource exists, which is itself an enumeration leak. The caller cannot
   * distinguish "this store doesn't exist" from "this store exists but isn't yours" from the
   * response, by design.
   */
  get: protectedProcedure.input(getInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.id);

    if (!store || !canAccessStore(ctx.session, store.id)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    return store;
  }),
});
