import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { canAccessStore } from '@retailos/authz';
import { DocumentRepository, InvoiceMatchRepository, StoreRepository } from '@retailos/db';
import { protectedProcedure, router } from '../trpc';

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
 * 008-10 (plan.md Phase 4, spec 05 §5.2.4): the real read surface for `InvoiceMatchRepository`.
 * `runMatch` itself has no endpoint here — it runs automatically inside `documents.approve`
 * (confirmed with the user), not as a manually-triggered mutation, so this router is
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
    const lines = await repo.findLines(input.invoiceMatchId);
    return { invoiceMatch, lines };
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
    return repo.findPending(input.storeId);
  }),

  /**
   * 008-12: the one real resolution action, confirmed with the user — one mutation, a REQUIRED
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
