import type { ChatProvider } from '@retailos/ai';
import { classifyIntent, type IntentType } from '@retailos/ai';
import type { AuthContext } from '@retailos/authz';
import type { MetricContext } from '@retailos/metrics';
import { planMetricSelections, type RejectedSelection } from './planning';
import { executeSelections, type DeniedSelection, type FailedSelection } from './execute-selections';
import type { GroundingBundle } from './grounding-bundle';

/**
 * The first genuinely end-to-end caller of everything the earlier planning/execution work
 * built — "classify → plan → execute → grounding bundle assembled" as ONE real pipeline, not four
 * disconnected functions each only proven in isolation. This function IS the orchestrator, not a
 * narrow bundle-assembly-only function, since nothing else in this codebase yet calls
 * classify/plan/execute together and that composition is genuinely this file's own scope, matching
 * the assistant's request pipeline framing where these steps flow together.
 *
 * **Retrieval does not exist yet.** A `RETRIEVAL`/`HYBRID`-intent question genuinely cannot be
 * fully answered today — this pipeline does NOT silently return an empty bundle that would look
 * like a real (if data-less) "no results" answer; it returns a distinct `unsupported` outcome
 * naming exactly why, matching I7's "degrade to unknown, never guess" discipline applied to
 * pipeline routing rather than a single number. `ACTION_DRAFT` (not built) and a real
 * `UNSUPPORTED` classification get the same honest treatment — this function makes no attempt to
 * force an answer out of a capability that isn't built yet.
 */
export type PipelineOutcome =
  | { kind: 'bundle'; intent: IntentType; bundle: GroundingBundle; denied: DeniedSelection[]; failed: FailedSelection[]; rejected: RejectedSelection[] }
  | { kind: 'unsupported'; intent: IntentType; reason: string }
  | { kind: 'error'; reason: string };

const UNSUPPORTED_REASONS: Partial<Record<IntentType, string>> = {
  RETRIEVAL: 'This question needs document/review search, which is not built yet.',
  HYBRID: 'This question needs both a metric and document/review search; document search is not built yet.',
  ACTION_DRAFT: 'Action requests (e.g. creating a draft purchase order) are not built yet.',
  UNSUPPORTED: 'This question is outside what this assistant can currently answer.',
};

/**
 * `question + ctx → GroundingBundle`, or an honest `unsupported`/`error` outcome when the real
 * pipeline genuinely can't proceed. Every model call (`classifyIntent`, `planMetricSelections`)
 * already degrades to a real, typed result rather than throwing (their own established
 * contracts) — this function does not add a second layer of error handling on top, it reads what
 * those functions already report.
 */
export const runPipeline = async (
  question: string,
  provider: ChatProvider,
  classifyModel: string,
  planModel: string,
  auth: AuthContext,
  ctx: MetricContext
): Promise<PipelineOutcome> => {
  const classification = await classifyIntent(provider, question, classifyModel);
  if (classification.error) {
    return { kind: 'error', reason: classification.error };
  }

  if (classification.intent !== 'METRIC') {
    return { kind: 'unsupported', intent: classification.intent, reason: UNSUPPORTED_REASONS[classification.intent] ?? 'This question is not currently supported.' };
  }

  const plan = await planMetricSelections(provider, question, planModel);
  if (plan.error) {
    return { kind: 'error', reason: plan.error };
  }

  const execution = await executeSelections(plan.selections, auth, ctx);

  const bundle: GroundingBundle = {
    metrics: execution.results,
    passages: [],
    entities: [],
  };

  return {
    kind: 'bundle',
    intent: classification.intent,
    bundle,
    denied: execution.denied,
    failed: execution.failed,
    rejected: plan.rejected,
  };
};
