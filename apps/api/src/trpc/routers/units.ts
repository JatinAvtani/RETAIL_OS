import { UnitRepository } from '@retailos/db';
import { protectedProcedure, router } from '../trpc';

/**
 * units is a global, unauthenticated-content lookup table (no organization_id, no RLS — see
 * schema comments) — still gated on a valid session, not made public, since there's no reason for
 * this API to answer unauthenticated requests at all.
 */
export const unitsRouter = router({
  list: protectedProcedure.query(({ ctx }) => {
    const unitRepository = new UnitRepository(ctx.db);
    return unitRepository.findAll();
  }),
});
