import type { ChatProvider } from '@retailos/ai';
import { classifyIntent, type IntentType } from '@retailos/ai';
import type { AuthContext } from '@retailos/authz';
import type { MetricContext } from '@retailos/metrics';
import type { SearchRepository } from '@retailos/db';
import { planMetricSelections, type RejectedSelection } from './planning';
import { executeSelections, type DeniedSelection, type FailedSelection } from './execute-selections';
import { resolveStoreParams, type AccessibleProduct, type AccessibleStore } from './resolve-store-params';
import { retrievePassages } from './retrieval';
import { planActionDraft, type ActionCandidate, type ActionDraftResult } from './action-draft';
import type { GroundingBundle } from './grounding-bundle';

/**
 * The first genuinely end-to-end caller of everything the earlier planning/execution work
 * built — "classify → plan → execute → grounding bundle assembled" as ONE real pipeline, not four
 * disconnected functions each only proven in isolation. This function IS the orchestrator, not a
 * narrow bundle-assembly-only function, since nothing else in this codebase yet calls
 * classify/plan/execute together and that composition is genuinely this file's own scope, matching
 * the assistant's request pipeline framing where these steps flow together.
 *
 * RETRIEVAL/HYBRID now route through `retrievePassages` (real document-chunk
 * hybrid search) instead of an automatic `unsupported` refusal.** A `RETRIEVAL` question runs
 * retrieval alone, producing a bundle with real `passages` and empty `metrics`. A `HYBRID`
 * question runs BOTH the metric pipeline (classify already routed here; plan/execute run exactly
 * as METRIC does) AND retrieval, producing a bundle with both real `metrics` and real `passages` —
 * matching the "genuinely needs both a computed number and retrieved context" framing.
 * `entities` stays empty — synthetic entity descriptions (products/suppliers) were settled as
 * real, deferred future scope, not built yet; a caller must not assume
 * `passages`-only retrieval also covers entity-description search. `retrievePassages` needs a real
 * `SearchRepository`, so `ctx` gained an optional `searchRepository` field — RETRIEVAL/HYBRID
 * questions asked without one (e.g. an older caller that hasn't been updated) degrade to an honest
 * `unsupported` outcome rather than crashing on a missing dependency.
 *
 * `ACTION_DRAFT` now routes through `planActionDraft` (`./action-draft`) — the caller supplies a
 * real `actionCandidates` list (`ctx.actionCandidates`, an org's confirmed supplier-product
 * mappings) and a `kind: 'draft'` outcome carries the proposed/rejected lines, never a mutation:
 * this pipeline still writes nothing (I9). A caller with no candidates configured (an older caller,
 * or an org with zero confirmed supplier-product mappings yet) gets the same honest `unsupported`
 * outcome as before rather than a confusing "0 candidates available" draft — there is genuinely
 * nothing to draft against yet, which is a different fact from "the model found no match."
 * A genuine `UNSUPPORTED` classification still gets the same honest refusal treatment as before.
 */
export type PipelineOutcome =
  | { kind: 'bundle'; intent: IntentType; bundle: GroundingBundle; denied: DeniedSelection[]; failed: FailedSelection[]; rejected: RejectedSelection[] }
  | { kind: 'draft'; intent: IntentType; draft: ActionDraftResult }
  | { kind: 'unsupported'; intent: IntentType; reason: string }
  | { kind: 'error'; reason: string };

const UNSUPPORTED_REASONS: Partial<Record<IntentType, string>> = {
  RETRIEVAL: 'Document search is not available (no search index configured for this caller).',
  HYBRID: 'Document search is not available (no search index configured for this caller).',
  ACTION_DRAFT: 'Action drafting is not available (no orderable products configured for this caller yet).',
  UNSUPPORTED: 'This question is outside what this assistant can currently answer.',
};

/**
 * `question + ctx → GroundingBundle`, or an honest `unsupported`/`error` outcome when the real
 * pipeline genuinely can't proceed. Every model call (`classifyIntent`, `planMetricSelections`)
 * already degrades to a real, typed result rather than throwing (their own established
 * contracts) — this function does not add a second layer of error handling on top, it reads what
 * those functions already report. `ctx.searchRepository`/`ctx.geminiApiKey` are optional —
 * METRIC-only callers (every existing caller, before this task) never need to supply them.
 */
export const runPipeline = async (
  question: string,
  provider: ChatProvider,
  classifyModel: string,
  planModel: string,
  auth: AuthContext,
  ctx: MetricContext & { searchRepository?: SearchRepository; geminiApiKey?: string },
  accessibleStores: AccessibleStore[],
  /** Real products of this org, so the planner can fill productId/variantId for the metrics that
   * require them. Empty means those metrics stay unreachable, which is the honest outcome. */
  products: AccessibleProduct[] = [],
  /** Real, confirmed supplier-product mappings this org can order from — `planActionDraft`'s own
   * closed candidate list (`./action-draft`). Empty/undefined means ACTION_DRAFT questions degrade
   * to the same honest `unsupported` outcome as before, never a draft against a fabricated list. */
  actionCandidates: ActionCandidate[] = []
): Promise<PipelineOutcome> => {
  const classification = await classifyIntent(provider, question, classifyModel);
  if (classification.error) {
    return { kind: 'error', reason: classification.error };
  }

  const { intent } = classification;

  if (intent === 'ACTION_DRAFT') {
    if (actionCandidates.length === 0) {
      return { kind: 'unsupported', intent, reason: UNSUPPORTED_REASONS[intent] ?? 'This question is not currently supported.' };
    }
    const draft = await planActionDraft(provider, question, planModel, actionCandidates);
    if (draft.error) {
      return { kind: 'error', reason: draft.error };
    }
    return { kind: 'draft', intent, draft };
  }

  if (intent === 'UNSUPPORTED') {
    return { kind: 'unsupported', intent, reason: UNSUPPORTED_REASONS[intent] ?? 'This question is not currently supported.' };
  }

  if ((intent === 'RETRIEVAL' || intent === 'HYBRID') && !ctx.searchRepository) {
    return { kind: 'unsupported', intent, reason: UNSUPPORTED_REASONS[intent] ?? 'This question is not currently supported.' };
  }

  let metrics: GroundingBundle['metrics'] = [];
  let metricScopes: (string | undefined)[] = [];
  let denied: DeniedSelection[] = [];
  let failed: FailedSelection[] = [];
  let rejected: RejectedSelection[] = [];

  if (intent === 'METRIC' || intent === 'HYBRID') {
    const plan = await planMetricSelections(provider, question, planModel, accessibleStores, new Date(), products);
    if (plan.error) {
      return { kind: 'error', reason: plan.error };
    }
    // The model is now GIVEN the real store list, but is never TRUSTED with it: any storeId it did
    // not copy from that list is rejected here, before execution. Without this, an invented but
    // syntactically valid UUID passes the metric's own `z.string().uuid()` schema, matches zero
    // rows under the org-scoped repositories, and a summing metric reports "0.0000" as a real
    // business number — an I7 violation the grounding validator cannot catch, because a metric
    // value is exactly what its allowlist permits.
    const storeCheck = resolveStoreParams(plan.selections, accessibleStores, products);
    const execution = await executeSelections(
      storeCheck.resolved,
      auth,
      ctx,
      new Map(accessibleStores.map((s) => [s.id, s.name]))
    );
    metrics = execution.results;
    metricScopes = execution.resultScopes;
    denied = execution.denied;
    failed = execution.failed;
    rejected = [...plan.rejected, ...storeCheck.rejected];
  }

  let passages: GroundingBundle['passages'] = [];
  if (intent === 'RETRIEVAL' || intent === 'HYBRID') {
    passages = await retrievePassages(question, { searchRepository: ctx.searchRepository!, geminiApiKey: ctx.geminiApiKey });
  }

  const bundle: GroundingBundle = { metrics, metricScopes, passages, entities: [] };

  return { kind: 'bundle', intent, bundle, denied, failed, rejected };
};
