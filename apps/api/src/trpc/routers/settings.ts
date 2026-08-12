import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { OrganizationRepository } from '@retailos/db';
import { protectedProcedure, router } from '../trpc';

const percentTolerance = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a plain decimal, e.g. 0.02 for 2%.')
  .refine((v) => Number(v) >= 0 && Number(v) <= 1, 'A percent tolerance must be between 0 and 1 (e.g. 0.02 for 2%).');

const absoluteTolerance = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a plain non-negative decimal amount.');

const updateMatchTolerancesInput = z.object({
  matchPriceTolerancePercent: percentTolerance.nullable().optional(),
  matchPriceToleranceAbsolute: absoluteTolerance.nullable().optional(),
  matchQuantityTolerancePercent: percentTolerance.nullable().optional(),
});

const requirePermission = (permissions: string[], permission: string) => {
  if (!permissions.includes(permission)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  }
};

/**
 * 008-11 (spec D8, "avoid alert fatigue on cents"): the real settings surface for the three-way
 * match's per-org tolerance override, confirmed with the user via `AskUserQuestion` as OWNER-only
 * — a financial-control threshold, matching this project's existing pattern of gating sensitive
 * config (PO approval limits) to the top role rather than the broader `purchasing:*` permissions
 * MANAGER also holds. Reuses `settings:manage` (already OWNER-exclusive in `ROLE_PERMISSIONS`, no
 * new permission enum value needed) — the first real caller of that permission in this codebase.
 */
export const settingsRouter = router({
  getMatchTolerances: protectedProcedure.query(async ({ ctx }) => {
    requirePermission(ctx.session.permissions, 'settings:manage');
    const repo = new OrganizationRepository(ctx.db, ctx.session.organizationId);
    const org = await repo.findMine();
    if (!org) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found.' });
    }
    return {
      matchPriceTolerancePercent: org.matchPriceTolerancePercent,
      matchPriceToleranceAbsolute: org.matchPriceToleranceAbsolute,
      matchQuantityTolerancePercent: org.matchQuantityTolerancePercent,
    };
  }),

  updateMatchTolerances: protectedProcedure.input(updateMatchTolerancesInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'settings:manage');
    const repo = new OrganizationRepository(ctx.db, ctx.session.organizationId);
    // `exactOptionalPropertyTypes` rejects zod's `T | undefined` optional fields being spread
    // directly into a `?:` shape (which means "absent," not "present as undefined") — mapped
    // explicitly per field, same discipline `purchase-orders.ts`/`goods-receipts.ts` already
    // established for this exact TS strictness setting.
    await repo.updateMatchTolerances({
      ...('matchPriceTolerancePercent' in input ? { matchPriceTolerancePercent: input.matchPriceTolerancePercent ?? null } : {}),
      ...('matchPriceToleranceAbsolute' in input ? { matchPriceToleranceAbsolute: input.matchPriceToleranceAbsolute ?? null } : {}),
      ...('matchQuantityTolerancePercent' in input ? { matchQuantityTolerancePercent: input.matchQuantityTolerancePercent ?? null } : {}),
    });
    const org = await repo.findMine();
    return {
      matchPriceTolerancePercent: org?.matchPriceTolerancePercent ?? null,
      matchPriceToleranceAbsolute: org?.matchPriceToleranceAbsolute ?? null,
      matchQuantityTolerancePercent: org?.matchQuantityTolerancePercent ?? null,
    };
  }),
});
