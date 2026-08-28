import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  ConversationRepository,
  MessageRepository,
  SearchRepository,
  ProductRepository,
  StoreRepository,
} from '@retailos/db';
import { createGeminiChatProvider, modelForTask } from '@retailos/ai';
import type { AuthContext, Permission } from '@retailos/authz';
import { canAccessStore } from '@retailos/authz';
import type { MetricContext, MetricResult } from '@retailos/metrics';
import { executeMetric, MetricPermissionDeniedError } from '@retailos/metrics';
import {
  runPipeline,
  narrateAndValidate,
  buildRefusal,
  buildCitations,
  rankExceptions,
  toBriefingBundle,
  type BriefingCandidate,
  type RefusalInfo,
  type GroundingBundle,
} from '@retailos/assistant';
import { protectedProcedure, router } from '../trpc';

/**
 * the first real HTTP surface for the entire AI assistant. Every prior piece
 * built real, tested library code with zero caller outside a temporary
 * verification script; this router is that caller. It composes exactly the pieces those tasks
 * already built — `runPipeline` (classify → plan/execute and/or retrieve), `narrateAndValidate`
 * (the load-bearing safety gate — NEVER call `narrate` directly and trust its output, see
 * `narration.ts`'s own header comment), `buildRefusal` (a structured explanation alongside, or
 * instead of, prose) — and adds nothing new to the actual answering logic. This file's only real
 * job is auth/session plumbing, conversation/message persistence, and shaping the HTTP response.
 *
 * **No new permission gate at the router level.** `executeSelections` already enforces
 * `requiredPermission` per metric selection (I9-adjacent: "Staff asking about margin gets a
 * permission refusal, not data"), feeding denials back through `denied` → `buildRefusal` → a real,
 * specific, per-item explanation the user sees. A blanket router-level permission check would
 * either duplicate that enforcement or, worse, block an otherwise-answerable multi-part question
 * for a caller who is only missing ONE of several things asked about — matching `dashboard.ts`'s
 * own established per-metric graceful-degradation precedent, not `search.documents`' single-purpose
 * hard-403 shape (this endpoint is multi-purpose by nature).
 */
const askInput = z.object({
  question: z.string().min(1).max(2000),
  /** Omit to start a new conversation. `ConversationRepository`/`MessageRepository` are both
   * `TenantScopedRepository`s — a cross-org conversationId resolves to nothing (never another
   * org's transcript), matching every other id-scoped lookup in this codebase. */
  conversationId: z.string().uuid().optional(),
});

export type AskRefusalItem = RefusalInfo['items'][number];

/**
 * The one user-facing sentence for "the model was unreachable". Deliberately a single shared
 * constant: it is written into the persisted `messages.content` AND rendered live by the web client,
 * and those two must not drift — a reloaded conversation should read exactly as it did live.
 */
export const PROVIDER_UNAVAILABLE_MESSAGE =
  "The assistant couldn't reach the model right now. Please try again in a moment.";

/** The lookback for the briefing's window-based exception metrics (waste/sales anomalies). Matches
 * the dashboard's own default period so the two surfaces never disagree about the same day. */
const BRIEFING_WINDOW_DAYS = 30;

const buildAuthContext = (session: { userId: string; organizationId: string; storeIds: string[] | 'ALL'; role: AuthContext['role']; permissions: string[] }): AuthContext => ({
  userId: session.userId,
  organizationId: session.organizationId,
  storeIds: session.storeIds,
  role: session.role,
  permissions: new Set(session.permissions as Permission[]),
});

export const assistantRouter = router({
  ask: protectedProcedure.input(askInput).mutation(async ({ ctx, input }) => {
    const organizationId = ctx.session.organizationId;
    const conversationRepository = new ConversationRepository(ctx.db, organizationId);
    const messageRepository = new MessageRepository(ctx.db, organizationId);

    let conversationId = input.conversationId;
    if (conversationId) {
      const existing = await conversationRepository.findById(conversationId);
      if (!existing) {
        // Cross-org id or a genuinely nonexistent one — identical 404 either way (never leaks
        // which case it was), matching every other id-scoped lookup's cross-tenant convention.
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found.' });
      }
    } else {
      // The first question doubles as the conversation's title — real data already in hand, not a
      // second "name this conversation" step. Truncated only for the sidebar list's own width, never
      // for the underlying message content.
      const created = await conversationRepository.create({
        userId: ctx.session.userId,
        title: input.question.slice(0, 120),
      });
      conversationId = created.id;
    }

    await messageRepository.create({ conversationId, role: 'USER', content: input.question });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // No key configured (CI, a fresh clone) — a real, typed `error` outcome, the SAME shape
      // `runPipeline` itself already returns for a live provider failure (a 429/503/etc). A first
      // draft of this router threw a hard 500 here instead — the ONLY place in this whole pipeline
      // that turned a provider problem into an HTTP error rather than a normal, typed result;
      // every other stage (classify/plan/execute) already degrades gracefully. Fixed to match:
      // never a fabricated answer, but also never an exception for a genuinely unexceptional,
      // anticipated condition this codebase already has a real vocabulary for.
      await messageRepository.create({ conversationId, role: 'ASSISTANT', content: 'The assistant is not configured on this server (no API key).', validationResult: { grounded: false, providerError: 'no API key configured' } });
      return { conversationId, kind: 'error' as const, reason: 'The assistant is not configured on this server (no API key).' };
    }
    const provider = createGeminiChatProvider(apiKey);

    const auth = buildAuthContext(ctx.session);
    const metricCtx: MetricContext & { searchRepository: SearchRepository; geminiApiKey: string } = {
      db: ctx.db,
      organizationId,
      storeIds: ctx.session.storeIds,
      searchRepository: new SearchRepository(ctx.db, organizationId),
      geminiApiKey: apiKey,
    };

    // The planner is given the caller's REAL stores so it never has to invent a storeId, and the
    // pipeline rejects any storeId not drawn from this list before a metric runs. Both layers are
    // load-bearing: without the list the model fabricates a UUID, and without the check a
    // fabricated-but-valid UUID matches zero rows and a summing metric reports "0.0000" as a real
    // number. `findAll` is org-scoped, so this resolves the tenant boundary the same way
    // `briefing`'s own repository lookup does — the session's `storeIds` alone would not, since a
    // `storeIds: 'ALL'` caller's list accepts any org's store id.
    const accessibleStores = (await new StoreRepository(ctx.db, organizationId).findAll())
      .filter((store) => canAccessStore(ctx.session, store.id))
      .map((store) => ({ id: store.id, name: store.name }));

    // Products, for the metrics that need a productId/variantId pair. Same discipline as stores:
    // the planner is GIVEN the real list and never trusted with an id it did not copy from it.
    const accessibleProducts = await new ProductRepository(ctx.db, organizationId).findAllWithDefaultVariant();

    const outcome = await runPipeline(input.question, provider, modelForTask('CLASSIFY'), modelForTask('PLAN'), auth, metricCtx, accessibleStores, accessibleProducts);

    if (outcome.kind === 'error') {
      // `outcome.reason` is the RAW provider error (a Gemini 429/503 JSON body, etc.) — diagnostic,
      // never user-facing. It is preserved verbatim in `validationResult.providerError` for real
      // debugging, while `content` gets the honest, human sentence, because `content` is what any
      // later reader renders: reloading this conversation from history displays the stored row
      // directly, with no second chance to translate it. An earlier version stored the raw blob as
      // `content` and a real screenshot of a reloaded thread showed a user-facing 503 JSON dump.
      await messageRepository.create({
        conversationId,
        role: 'ASSISTANT',
        content: PROVIDER_UNAVAILABLE_MESSAGE,
        validationResult: { grounded: false, providerError: outcome.reason },
      });
      return { conversationId, kind: 'error' as const, reason: outcome.reason };
    }

    if (outcome.kind === 'unsupported') {
      await messageRepository.create({ conversationId, role: 'ASSISTANT', content: outcome.reason, validationResult: { grounded: false, unsupportedIntent: outcome.intent } });
      return { conversationId, kind: 'unsupported' as const, intent: outcome.intent, reason: outcome.reason };
    }

    const { bundle, denied, failed, rejected } = outcome;
    const refusal = buildRefusal(bundle, denied, failed, rejected, outcome.intent === 'METRIC' || outcome.intent === 'HYBRID');
    const narrated = await narrateAndValidate(provider, bundle, denied, failed, rejected, modelForTask('NARRATE'));

    await messageRepository.create({
      conversationId,
      role: 'ASSISTANT',
      // `narrated.text` is trustworthy ONLY when `grounded: true` — the fail-closed contract
      // `narrateAndValidate` itself documents. An ungrounded/failed narration still gets a real,
      // honest message row (never a blank one), built from the structured bundle instead of prose.
      content: narrated.grounded && narrated.text ? narrated.text : fallbackContentFromBundle(bundle, refusal),
      groundingBundle: bundle,
      modelVersion: modelForTask('NARRATE'),
      validationResult: { grounded: narrated.grounded, violationLog: narrated.violationLog },
    });

    return {
      conversationId,
      kind: 'bundle' as const,
      intent: outcome.intent,
      text: narrated.grounded ? narrated.text : null,
      grounded: narrated.grounded,
      bundle,
      refusal,
      // Derived from the bundle, never from the model — a citation the model could influence would
      // look like proof while being exactly as unreliable as the prose it is meant to back up.
      citations: buildCitations(bundle),
    };
  }),

  /**
   * The daily briefing: "compute exceptions → rank by dollar impact → top 3–6 → LLM writes only the
   * connective prose; every figure comes from a metric call. Same validator applies."
   *
   * The exception set is computed by the SAME already-registered metrics the dashboard's own
   * exception feed reads (I2) — this endpoint adds no new business calculation. Ranking is pure and
   * deterministic (`rankExceptions`); the model's only job is connective prose over figures it is
   * handed, policed by the same `narrateAndValidate` gate every other narration path uses.
   *
   * Degrades exactly like the dashboard feed: a metric the caller lacks permission for is omitted
   * from the briefing rather than failing the whole request, so a Manager still gets the exceptions
   * they CAN see instead of an error.
   */
  briefing: protectedProcedure
    .input(z.object({ storeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.session.organizationId;

      // The two-layer store check every other store-scoped procedure uses (purchase-orders.ts,
      // inventory.ts, goods-receipts.ts…). BOTH layers are load-bearing: `canAccessStore` alone
      // reads the session's own store list, which for a `storeIds: 'ALL'` caller accepts ANY
      // org's storeId — so the org-scoped repository lookup is what actually proves the store
      // belongs to this tenant. Runs FIRST, before any metric executes.
      const storeRepository = new StoreRepository(ctx.db, organizationId);
      const store = await storeRepository.findById(input.storeId);
      if (!store || !canAccessStore(ctx.session, input.storeId)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
      }

      const auth = buildAuthContext(ctx.session);
      const metricCtx: MetricContext = { db: ctx.db, organizationId, storeIds: ctx.session.storeIds };

      const tryMetric = async (fn: () => Promise<MetricResult>): Promise<MetricResult | null> => {
        try {
          return await fn();
        } catch (error) {
          if (error instanceof MetricPermissionDeniedError) return null;
          throw error;
        }
      };

      const to = new Date();
      const from = new Date(to.getTime() - BRIEFING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const windowParams = { storeId: input.storeId, from, to };

      // Each entry pairs a real registered metric with the plain description shown to the user. The
      // labels deliberately contain NO figure — the figure lives in the MetricResult, so a label can
      // never drift from the number it describes.
      // `scope` names the store each candidate's metric was actually computed over — every spec
      // below is called with THIS request's own `input.storeId` except `stock_projection_drift`,
      // deliberately called with `{}` (org-wide — a data-integrity check over the whole org's
      // ledger, not a per-store figure). Without an explicit scope label, an org-wide figure
      // surfacing inside one store's briefing would read as if it were about that store alone — a
      // real misattribution once the org has more than one store.
      const specs: { id: string; severity: 'danger' | 'warning'; label: string; scope: string | undefined; run: () => Promise<MetricResult> }[] = [
        {
          id: 'expiry_risk_value',
          severity: 'warning',
          label: 'Stock is approaching its expiry date',
          scope: store.name,
          run: () => executeMetric('expiry_risk_value', { storeId: input.storeId, horizonDays: 7 }, auth, metricCtx),
        },
        {
          id: 'dead_stock_value',
          severity: 'warning',
          label: 'Stock is sitting unsold',
          scope: store.name,
          run: () => executeMetric('dead_stock_value', { storeId: input.storeId }, auth, metricCtx),
        },
        {
          id: 'negative_stock_incidents',
          severity: 'danger',
          label: 'Products are showing negative stock',
          scope: store.name,
          run: () => executeMetric('negative_stock_incidents', { storeId: input.storeId }, auth, metricCtx),
        },
        {
          id: 'stock_projection_drift',
          severity: 'danger',
          label: 'Stock records disagree with the ledger — a data-integrity problem',
          scope: 'entire organization (all stores)',
          run: () => executeMetric('stock_projection_drift', {}, auth, metricCtx),
        },
        {
          id: 'documents_pending_review',
          severity: 'warning',
          label: 'Documents are awaiting review',
          scope: store.name,
          run: () => executeMetric('documents_pending_review', { storeId: input.storeId }, auth, metricCtx),
        },
        {
          id: 'unmapped_pos_items_count',
          severity: 'warning',
          label: 'POS items are still unmapped, so consumption data is incomplete',
          scope: store.name,
          run: () => executeMetric('unmapped_pos_items_count', { storeId: input.storeId }, auth, metricCtx),
        },
        {
          id: 'waste_spike',
          severity: 'warning',
          label: 'Waste was unusually high on some days',
          scope: store.name,
          run: () => executeMetric('waste_spike', windowParams, auth, metricCtx),
        },
        {
          id: 'sales_anomaly',
          severity: 'warning',
          label: 'Sales activity was unusual on some days',
          scope: store.name,
          run: () => executeMetric('sales_anomaly', windowParams, auth, metricCtx),
        },
      ];

      const settled = await Promise.all(specs.map(async (spec) => ({ spec, result: await tryMetric(spec.run) })));
      const candidates: BriefingCandidate[] = settled
        .filter((s): s is { spec: (typeof specs)[number]; result: MetricResult } => s.result !== null)
        .map(({ spec, result }) => ({ id: spec.id, severity: spec.severity, label: spec.label, scope: spec.scope, result }));

      const ranked = rankExceptions(candidates);
      const bundle = toBriefingBundle(ranked);

      // A genuinely calm day is a real, honest result — never a model call asking prose to be
      // written about nothing, which is precisely how a fabricated "everything looks great, revenue
      // is up" sentence would get invented.
      if (ranked.length === 0) {
        return { exceptions: [], text: null, grounded: false, citations: buildCitations(bundle), quiet: true as const };
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        // The ranked exceptions are real and useful WITHOUT prose — the model only ever supplied
        // the connective sentences. So a missing key degrades to the structured briefing, not an error.
        return { exceptions: ranked, text: null, grounded: false, citations: buildCitations(bundle), quiet: false as const };
      }

      const provider = createGeminiChatProvider(apiKey);
      const narrated = await narrateAndValidate(provider, bundle, [], [], [], modelForTask('NARRATE'));

      return {
        exceptions: ranked,
        text: narrated.grounded ? narrated.text : null,
        grounded: narrated.grounded,
        citations: buildCitations(bundle),
        quiet: false as const,
      };
    }),

  getConversation: protectedProcedure.input(z.object({ conversationId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const conversationRepository = new ConversationRepository(ctx.db, ctx.session.organizationId);
    const conversation = await conversationRepository.findById(input.conversationId);
    if (!conversation) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found.' });
    }
    const messageRepository = new MessageRepository(ctx.db, ctx.session.organizationId);
    const messages = await messageRepository.findForConversation(input.conversationId);
    // Citations are REBUILT from each stored bundle rather than persisted alongside it. The bundle
    // is the durable record; a citation is a pure projection of it, so deriving it on read means a
    // reloaded conversation shows the same proof a live answer did — and an improvement to
    // `buildCitations` applies retroactively to old conversations instead of only new ones.
    return {
      conversation,
      messages: messages.map((m) => ({
        ...m,
        citations: m.groundingBundle ? buildCitations(m.groundingBundle as GroundingBundle) : null,
      })),
    };
  }),

  listConversations: protectedProcedure.query(async ({ ctx }) => {
    const conversationRepository = new ConversationRepository(ctx.db, ctx.session.organizationId);
    return conversationRepository.findForUser(ctx.session.userId);
  }),
});

/**
 * The user-facing fallback when prose can't be trusted (fail-closed) or genuinely never existed
 * (empty bundle). Deliberately does NOT invent explanatory sentences — it renders exactly what
 * `refusal`/`bundle` already say, structured, matching this codebase's "never fabricate a
 * 'something went wrong' message with its own invented wording" rule (`narration.ts`'s own header
 * comment) — inventing NEW prose here would risk the same ungrounded-claim problem the validator
 * exists to catch, just one layer up.
 */
/** `net_revenue` → `Net revenue` — the human label a metric id already encodes. */
const metricLabel = (metricId: string): string => {
  const words = metricId.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The stored value verbatim, minus trailing decimal zeros (`2310.0000` → `2310`) — a formatting
 * trim the validator's own tolerance already treats as the same number, never a recomputation.
 * No currency symbol: `MetricResult` carries no currency code, and attaching one the system does
 * not know would be a small fabrication of its own.
 */
const displayValue = (value: string, unit?: string): string => {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return unit === 'PERCENTAGE' ? `${trimmed}%` : trimmed;
};

const fallbackContentFromBundle = (
  bundle: { metrics: { metricId: string; value: string; unit?: string }[] },
  refusal: RefusalInfo | null
): string => {
  const knownMetrics = bundle.metrics.filter((m) => m.value !== 'unknown');
  if (knownMetrics.length === 0 && !refusal) {
    return 'No information was found to answer this question.';
  }
  const parts: string[] = [];
  if (knownMetrics.length > 0) {
    // This is the degraded path — what renders when narration failed or was discarded — so it is
    // ALSO what a reader judges the product by whenever the model is unavailable. Raw metric ids
    // (`net_revenue = 2310.0000`) read as debug output; the same facts phrased as labels do not.
    parts.push(
      `Here is what was found — ${knownMetrics
        .map((m) => `${metricLabel(m.metricId)}: ${displayValue(m.value, m.unit)}`)
        .join(', ')}.`
    );
  }
  if (refusal) {
    parts.push(`${refusal.items.length} item(s) could not be fully answered — see details below.`);
  }
  return parts.join(' ');
};
