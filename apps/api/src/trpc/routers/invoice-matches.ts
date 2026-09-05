import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { Decimal } from 'decimal.js';
import { canAccessStore } from '@retailos/authz';
import { DocumentRepository, InvoiceMatchRepository, StoreRepository } from '@retailos/db';
import { computeLineDollarImpact, computeMatchDollarImpact, type LineForDollarImpact, type VarianceType } from '@retailos/domain';
import { protectedProcedure, router } from '../trpc';

/** tRPC's plain-JSON transport cannot carry a Decimal instance — `null !== null ? .toFixed(4) : null` at every call site, exactly matching how `invoiceMatches.pending` already handles its own dollarImpact field, never a parallel formula (I2: `computeLineDollarImpact`/`computeMatchDollarImpact` are the single source, this only re-shapes their real output for HTTP). */
const toLineForImpact = (line: { varianceType: string; priceVariance: string | null; quantityVariance: string | null; invoiceQuantity: string | null; invoiceUnitPrice: string | null }): LineForDollarImpact => ({
  varianceType: line.varianceType as VarianceType,
  priceVariance: line.priceVariance !== null ? new Decimal(line.priceVariance) : null,
  quantityVariance: line.quantityVariance !== null ? new Decimal(line.quantityVariance) : null,
  invoiceQuantity: line.invoiceQuantity !== null ? new Decimal(line.invoiceQuantity) : null,
  invoiceUnitPrice: line.invoiceUnitPrice !== null ? new Decimal(line.invoiceUnitPrice) : null,
});

const getInput = z.object({ invoiceMatchId: z.string().uuid() });
const getByDocumentInput = z.object({ documentId: z.string().uuid() });
const pendingInput = z.object({ storeId: z.string().uuid().optional() });
const resolveInput = z.object({
  invoiceMatchId: z.string().uuid(),
  resolutionNotes: z.string().trim().min(1, 'A resolution note is required.').max(2000),
});

const requirePermission = (permissions: string[], permission: string) => {
  if (!permissions.includes(permission)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  }
};

/**
 * the real read surface for `InvoiceMatchRepository`.
 * `runMatch` itself has no endpoint here — it runs automatically inside `documents.approve`,
 * not as a manually-triggered mutation, so this router is
 * read-only, matching `documents.ts`'s own `accuracyTelemetry`-style reporting endpoints.
 */
export const invoiceMatchesRouter = router({
  get: protectedProcedure.input(getInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:read');
    const repo = new InvoiceMatchRepository(ctx.db, ctx.session.organizationId);
    const invoiceMatch = await repo.findById(input.invoiceMatchId);
    if (!invoiceMatch || !canAccessStore(ctx.session, invoiceMatch.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invoice match not found.' });
    }
    const rawLines = await repo.findLines(input.invoiceMatchId);
    // Every line's real dollar impact, plus the match's own real total — the three-way-match
    // screen's own "no totals row" gap. Computed here, once, from the exact same pure function
    // the variance queue already uses (I2), never a second formula re-derived in the frontend.
    const forImpact = rawLines.map(toLineForImpact);
    const lines = rawLines.map((line, i) => ({ ...line, dollarImpact: computeLineDollarImpact(forImpact[i]!)?.toFixed(4) ?? null }));
    const totalDollarImpact = computeMatchDollarImpact(forImpact)?.toFixed(4) ?? null;
    return { invoiceMatch, lines, totalDollarImpact };
  }),

  /**
   * A cross-org `documentId` must return a real 404, matching every other id-scoped endpoint's
   * convention in this codebase (`suppliers.confirmedProducts`'s own past cross-tenant fix is the
   * precedent) — found by the cross-tenant suite itself, not by review: an earlier draft returned
   * `null` for BOTH "no match yet" and "not your document," which is a genuine 200-vs-404 shape
   * mismatch even though no data actually leaks (`InvoiceMatchRepository` is already org-scoped).
   * `DocumentRepository.findById` (tenant-scoped) is the real existence check; only once the
   * document itself is confirmed to belong to the caller's org does "no match yet" become a
   * legitimate `null`, not a 404.
   */
  getByDocument: protectedProcedure.input(getByDocumentInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:read');
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const document = await documentRepository.findById(input.documentId);
    if (!document || !canAccessStore(ctx.session, document.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }
    const repo = new InvoiceMatchRepository(ctx.db, ctx.session.organizationId);
    const invoiceMatch = await repo.findByDocumentId(input.documentId);
    if (!invoiceMatch) {
      return null;
    }
    const lines = await repo.findLines(invoiceMatch.id);
    return { invoiceMatch, lines };
  }),

  /**
   * The variance review queue's real read path — every `PENDING` match with a real variance
   * (`highestSeverity <> 'NONE'`, filtered in `InvoiceMatchRepository.findPending` itself), worst
   * severity first. `storeId` is optional (org-wide) but, when provided, must pass the same real
   * `StoreRepository`-backed access check `assertStoreAccess` establishes elsewhere in this
   * codebase — `canAccessStore` alone is blind to organization for a session with `storeIds: 'ALL'`.
   */
  pending: protectedProcedure.input(pendingInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:read');
    if (input.storeId !== undefined) {
      const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
      const store = await storeRepository.findById(input.storeId);
      if (!store || !canAccessStore(ctx.session, input.storeId)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
      }
    }
    const repo = new InvoiceMatchRepository(ctx.db, ctx.session.organizationId);
    const pending = await repo.findPending(input.storeId);
    // tRPC's plain-JSON transport cannot carry a Decimal instance — every other money-shaped field
    // this router returns is already a plain string by the time it leaves the repository; this is
    // the one field `findPending` still hands back as a real Decimal, so it's converted here at the
    // router boundary rather than inside the repository (which other, non-HTTP callers may want as
    // a real Decimal to do further arithmetic on).
    return pending.map((match) => ({ ...match, dollarImpact: match.dollarImpact !== null ? match.dollarImpact.toFixed(4) : null }));
  }),

  /**
   * the one real resolution action — one mutation, a REQUIRED
   * note, `PENDING` straight to `RESOLVED`. Gated on `purchasing:approve` (not the broader
   * `purchasing:write`) since resolving a flagged variance is a real financial-control decision —
   * matching this project's existing pattern of reserving `purchasing:approve` for PO approval,
   * the other place a monetary judgment call is made rather than routine data entry.
   */
  resolve: protectedProcedure.input(resolveInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:approve');
    const repo = new InvoiceMatchRepository(ctx.db, ctx.session.organizationId);
    const invoiceMatch = await repo.findById(input.invoiceMatchId);
    if (!invoiceMatch || !canAccessStore(ctx.session, invoiceMatch.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invoice match not found.' });
    }
    const result = await repo.resolve(input.invoiceMatchId, ctx.session.userId, input.resolutionNotes);
    if (!result.ok) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: result.reason === 'ALREADY_RESOLVED' ? 'This invoice match has already been resolved.' : 'Invoice match not found.',
      });
    }
    return repo.findById(input.invoiceMatchId);
  }),
});
