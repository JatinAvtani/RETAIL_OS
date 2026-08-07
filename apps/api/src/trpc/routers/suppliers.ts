import { z } from 'zod';
import { SupplierRepository } from '@retailos/db';
import { generateId } from '@retailos/domain';
import { protectedProcedure, router } from '../trpc';

const createInput = z.object({ name: z.string().min(1) });

/**
 * 007-10: the review screen's correction flow needs to resolve an extracted supplier name to a
 * real `suppliers` row (or create one — an invoice from a genuinely new supplier is routine, not
 * an error state). `SupplierRepository` existed since 004-05 but had no tRPC surface at all until
 * this task became its first caller.
 */
export const suppliersRouter = router({
  list: protectedProcedure.query(({ ctx }) => {
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    return supplierRepository.findAll();
  }),

  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    return supplierRepository.create({ id: generateId(), name: input.name });
  }),
});
