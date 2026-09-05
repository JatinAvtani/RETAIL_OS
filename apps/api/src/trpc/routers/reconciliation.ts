import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { gatherReconciliationBatch, organizations, StoreRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { protectedProcedure, router } from '../trpc';

/**
 * the real HTTP surface for the batch-reconciliation report — the direct
 * answer to the Razorpay AI Buildathon "AI Finance Controller" track's own literal brief ("closes
 * one finance-ops loop across a 50+ record batch of synthetic data, reporting its match rate and
 * the exceptions it could not resolve"). Composes exactly `gatherReconciliationBatch`
 * (`packages/db`, its own real data-gathering over already-persisted `invoice_match_lines`) —
 * this router adds nothing to the reconciliation logic itself, matching `assistant.ts`'s/
 * `finance-controller.ts`'s own established "router is plumbing, not logic" discipline.
 */
const requirePermission = (permissions: string[], permission: string) => {
 if (!permissions.includes(permission)) {
 throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
 }
};

export const reconciliationRouter = router({
 /**
 * Store-scoped (matching `dashboard.summary`'s own established shape) — `storeId` optional
 * mirrors `gatherReconciliationBatch`'s own signature (an org-wide batch when omitted). A
 * supplied `storeId` is checked against the caller's real accessible stores before ever reaching
 * the query, the same two-layer discipline `assistant.briefing`'s registry entry already proves.
 */
 batchReport: protectedProcedure.input(
 z.object({
 storeId: z.string().uuid().optional(),
 sinceDays: z.number().int().positive().max(365).optional(),
 limit: z.number().int().positive().max(1000).optional(),
 })).query(async ({ ctx, input }) => {
 requirePermission(ctx.session.permissions, 'financial:read');

 // Two-layer store check (`assistant.briefing`'s own established precedent) — `canAccessStore`
 // alone reads the session's own store list, which for a `storeIds: 'ALL'` caller accepts ANY
 // org's storeId; the org-scoped repository lookup is what actually proves the store belongs
 // to THIS tenant. A real cross-tenant leak was found here live via the cross-tenant registry's
 // own merge-gate test before this fix.
 if (input.storeId !== undefined) {
 const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
 const store = await storeRepository.findById(input.storeId);
 if (!store || !canAccessStore(ctx.session, input.storeId)) {
 throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this store.' });
 }
 }

 const since = input.sinceDays !== undefined ? new Date(Date.now() - input.sinceDays * 24 * 60 * 60 * 1000) : undefined;

 const report = await gatherReconciliationBatch(ctx.db, ctx.session.organizationId, {...(input.storeId !== undefined ? { storeId: input.storeId } : {}), ...(since !== undefined ? { since } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}),
 });

 // The org's REAL base currency, resolved the same way `dashboard.summary` does. Without it
 // the UI rendered every impact figure bare ("553237.25"), which on an INR org reads as an
 // unlabelled number — the report's headline figures are money and must say so.
 const [orgRow] = await ctx.db.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, ctx.session.organizationId));

 return {...report, currency: orgRow?.baseCurrency ?? 'USD' };
 }),
});
