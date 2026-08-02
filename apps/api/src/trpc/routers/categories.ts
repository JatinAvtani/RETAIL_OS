import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { CategoryRepository } from '@retailos/db';
import { generateId } from '@retailos/domain';
import { protectedProcedure, router } from '../trpc';

const createInput = z.object({
  name: z.string().min(1),
  parentId: z.string().uuid().optional(),
});

/**
 * The catalog UI's category dropdown/creation needs a real endpoint — this was schema+repository
 * only (004-01) until now, no tRPC layer existed for it.
 */
export const categoriesRouter = router({
  list: protectedProcedure.query(({ ctx }) => {
    const categoryRepository = new CategoryRepository(ctx.db, ctx.session.organizationId);
    return categoryRepository.findAll();
  }),

  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const categoryRepository = new CategoryRepository(ctx.db, ctx.session.organizationId);
    try {
      return await categoryRepository.create({
        id: generateId(),
        name: input.name,
        ...(input.parentId !== undefined && { parentId: input.parentId }),
      });
    } catch (err) {
      // NOT_FOUND, not BAD_REQUEST — matches every other cross-tenant guard in this codebase.
      // CategoryRepository.create's own parentId lookup is already tenant-scoped, so a parentId
      // belonging to another org produces this same "not found" error, indistinguishably from a
      // genuine typo — which is the point.
      if (err instanceof Error && /not found/i.test(err.message)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  }),
});
