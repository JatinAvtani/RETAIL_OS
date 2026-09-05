import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
 InvestigationRepository,
 applyApprovedReorderDraft,
 ProductRepository,
 SearchRepository,
 StoreRepository,
 SupplierProductRepository,
} from '@retailos/db';
import { createGeminiChatProvider, modelForTask } from '@retailos/ai';
import type { AuthContext, Permission } from '@retailos/authz';
import { canAccessStore } from '@retailos/authz';
import { runInvestigation, type InvestigationOutcome } from '@retailos/assistant';
import { Decimal } from 'decimal.js';
import { protectedProcedure, router } from '../trpc';

/**
 * the real HTTP surface for the Finance Controller — a standalone page, not a mode of
 * the existing `assistant` router (confirmed design decision, see task.md). Composes exactly the
 * already-built, already-tested pieces: `InvestigationRepository` (its persistence layer),
 * `runInvestigation`, `applyApprovedReorderDraft` — this file's only real job is
 * auth/session plumbing and shaping the HTTP response, matching `assistant.ts`'s own established
 * "router adds nothing to the answering logic itself" discipline.
 */

const buildAuthContext = (session: { userId: string; organizationId: string; storeIds: string[] | 'ALL'; role: AuthContext['role']; permissions: string[] }): AuthContext => ({
 userId: session.userId,
 organizationId: session.organizationId,
 storeIds: session.storeIds,
 role: session.role,
 permissions: new Set(session.permissions as Permission[]),
});

/** Same plain-array-check shape `purchase-orders.ts`/`documents.ts` both already established. */
const requirePermission = (permissions: string[], permission: string) => {
 if (!permissions.includes(permission)) {
 throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
 }
};

const askInput = z.object({
 question: z.string().min(1).max(2000),
 storeId: z.string().uuid().optional(),
});

export const financeControllerRouter = router({
 /**
 * The feed's own real list — every completed, proactively-triggered investigation (its own
 * `findRecentProactive`), most recent first. Store-scoped by the caller's real accessible stores,
 * same discipline as every other list endpoint (`dashboard.summary`, `inventory.levels`).
 */
 listFindings: protectedProcedure.query(async ({ ctx }) => {
 requirePermission(ctx.session.permissions, 'financial:read');
 const organizationId = ctx.session.organizationId;
 const repo = new InvestigationRepository(ctx.db, organizationId);
 const rows = await repo.findRecentProactive();
 return rows.filter((row) => row.storeId === null || canAccessStore(ctx.session, row.storeId));
 }),

 /**
 * A single investigation's full detail — the real trace + draft a human reviews before
 * approving/rejecting anything. `investigationId` is org-scoped by `InvestigationRepository`
 * itself (a `TenantScopedRepository`), so a cross-org id resolves to nothing, matching every
 * other id-scoped lookup in this codebase (I4).
 */
 getInvestigation: protectedProcedure.input(z.object({ investigationId: z.string().uuid() })).query(async ({ ctx, input }) => {
 requirePermission(ctx.session.permissions, 'financial:read');
 const repo = new InvestigationRepository(ctx.db, ctx.session.organizationId);
 const investigation = await repo.findById(input.investigationId);
 if (!investigation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Investigation not found.' });
 if (investigation.storeId !== null && !canAccessStore(ctx.session, investigation.storeId)) {
 throw new TRPCError({ code: 'NOT_FOUND', message: 'Investigation not found.' });
 }
 return investigation;
 }),

 /**
 * The on-demand entry point (its own other real caller, alongside the proactive sweep) — a
 * user's own free-form question runs the exact same bounded multi-hop investigation, persisted
 * the exact same way, with NO `sourceNotificationId` (matching `InvestigationRepository
 *.findRecentProactive`'s own filter for "a real finding a human can open," which correctly
 * excludes this on-demand kind — it belongs to the caller who asked it, not the shared feed).
 */
 investigate: protectedProcedure.input(askInput).mutation(async ({ ctx, input }) => {
 requirePermission(ctx.session.permissions, 'financial:read');
 const organizationId = ctx.session.organizationId;

 const apiKey = process.env.GEMINI_API_KEY;
 if (!apiKey) {
 throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'The assistant is not configured on this server (no API key).' });
 }

 // The two-layer store check every other store-scoped procedure in this codebase uses
 // (`assistant.briefing`'s own established precedent) — `canAccessStore` alone reads the
 // session's own store list, which for a `storeIds: 'ALL'` caller accepts ANY org's storeId, so
 // the org-scoped repository lookup is what actually proves the store belongs to THIS tenant.
 // A real cross-tenant leak was found here live (the cross-tenant registry's own merge-gate
 // test caught it) before this fix — `canAccessStore` alone is never sufficient on its own.
 if (input.storeId !== undefined) {
 const storeRepository = new StoreRepository(ctx.db, organizationId);
 const store = await storeRepository.findById(input.storeId);
 if (!store || !canAccessStore(ctx.session, input.storeId)) {
 throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this store.' });
 }
 }

 const investigationRepo = new InvestigationRepository(ctx.db, organizationId);
 const { id: investigationId } = await investigationRepo.createRunning({...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
 question: input.question,
 });

 try {
 const provider = createGeminiChatProvider(apiKey);
 const auth = buildAuthContext(ctx.session);
 // `searchRepository` is required for a `HYBRID`/`RETRIEVAL`-classified question to ever
 // resolve — without it, `runPipeline` correctly, honestly refuses (I7: never fabricate an
 // answer it can't ground), but that meant EVERY question needing document context silently
 // couldn't be answered here, even though real retrieval already exists and `assistant.ts`
 // already wires it. Found live: a real question ("Why did margin drop this month?")
 // classified HYBRID with 0.95 confidence and resolved to an empty trace every time until
 // this was added.
 const metricCtx = {
 db: ctx.db,
 organizationId,
 storeIds: ctx.session.storeIds,
 geminiApiKey: apiKey,
 searchRepository: new SearchRepository(ctx.db, organizationId),
 };

 const accessibleStores = (await new StoreRepository(ctx.db, organizationId).findAll()).filter((store) => canAccessStore(ctx.session, store.id)).map((store) => ({ id: store.id, name: store.name }));
 const accessibleProducts = await new ProductRepository(ctx.db, organizationId).findAllWithDefaultVariant();
 const actionCandidates = await new SupplierProductRepository(ctx.db, organizationId).findAllConfirmedWithLabels();

 const outcome: InvestigationOutcome = await runInvestigation(
 input.question,
 provider,
 modelForTask('CLASSIFY'),
 modelForTask('PLAN'),
 modelForTask('NARRATE'),
 auth,
 metricCtx,
 accessibleStores,
 accessibleProducts,
 actionCandidates);

 if (outcome.kind === 'investigation') {
 await investigationRepo.complete(investigationId, { hopCount: outcome.steps.length, trace: outcome.steps, draft: null });
 return { investigationId, kind: 'investigation' as const, steps: outcome.steps };
 }
 if (outcome.kind === 'draft') {
 await investigationRepo.complete(investigationId, { hopCount: outcome.steps.length, trace: outcome.steps, draft: outcome.draft });
 return { investigationId, kind: 'draft' as const, steps: outcome.steps, draft: outcome.draft };
 }
 if (outcome.kind === 'unsupported') {
 await investigationRepo.complete(investigationId, { hopCount: 0, trace: [], draft: null });
 return { investigationId, kind: 'unsupported' as const, reason: outcome.reason };
 }
 // 'error' — a real provider/pipeline failure, distinct from an honest 'unsupported' refusal.
 await investigationRepo.fail(investigationId, outcome.reason);
 return { investigationId, kind: 'error' as const, reason: outcome.reason };
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 await investigationRepo.fail(investigationId, message);
 throw error;
 }
 }),

 /**
 * The real, human-gated write — the ONLY place an investigation's draft becomes a real
 * `purchase_orders`/`purchase_order_lines` row (via `applyApprovedReorderDraft`). Gated
 * on `purchasing:approve`, the SAME bar `purchase-orders.approve` already requires — approving a
 * draft PO is not a lesser action than approving a manually-created one. The model never calls
 * this; it is wired to a UI button's mutation only (I9).
 */
 approveDraftAction: protectedProcedure.input(
 z.object({
 investigationId: z.string().uuid(),
 storeId: z.string().uuid(),
 poNumber: z.string().trim().min(1).max(100).optional(),
 })).mutation(async ({ ctx, input }) => {
 requirePermission(ctx.session.permissions, 'purchasing:approve');
 const organizationId = ctx.session.organizationId;

 // Two-layer store check (see `investigate` above for the full reasoning) — the highest-
 // stakes instance of this pattern in the whole epic, since this is the write path that
 // creates a real purchase order.
 const storeRepository = new StoreRepository(ctx.db, organizationId);
 const store = await storeRepository.findById(input.storeId);
 if (!store || !canAccessStore(ctx.session, input.storeId)) {
 throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this store.' });
 }

 const investigationRepo = new InvestigationRepository(ctx.db, organizationId);
 const investigation = await investigationRepo.findById(input.investigationId);
 if (!investigation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Investigation not found.' });

 const draft = investigation.draft as { lines: { candidateId: string; label: string; quantity: string; unitLabel: string }[] } | null;
 if (draft === null || draft.lines.length === 0) {
 throw new TRPCError({ code: 'BAD_REQUEST', message: 'This investigation has no draft action to approve.' });
 }

 // The persisted draft's `quantity` round-tripped through JSONB as a plain number/string — a
 // real Decimal is reconstructed here, never trusted as already-safe (I5).
 const lines = draft.lines.map((line) => ({...line, quantity: new Decimal(line.quantity) }));

 const result = await applyApprovedReorderDraft(ctx.db, organizationId, input.storeId, ctx.session.userId, { lines }, input.poNumber);

 if (!result.ok) {
 throw new TRPCError({ code: 'BAD_REQUEST', message: result.reason });
 }
 return result;
 }),

 /**
 * A human explicitly declining a draft — recorded on the investigation itself (a rejected draft
 * is real signal, not silently discarded), never a write to any purchasing table.
 */
 rejectDraftAction: protectedProcedure.input(z.object({ investigationId: z.string().uuid(), reason: z.string().trim().max(500).optional() })).mutation(async ({ ctx, input }) => {
 requirePermission(ctx.session.permissions, 'financial:read');
 const investigationRepo = new InvestigationRepository(ctx.db, ctx.session.organizationId);
 const investigation = await investigationRepo.findById(input.investigationId);
 if (!investigation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Investigation not found.' });

 await investigationRepo.reject(investigation.id, input.reason);
 return { ok: true };
 }),
});
