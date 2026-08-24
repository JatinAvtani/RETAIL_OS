import {
  executeMetric,
  MetricPermissionDeniedError,
  UnknownMetricError,
  type MetricContext,
  type MetricResult,
} from '@retailos/metrics';
import type { AuthContext } from '@retailos/authz';
import type { ValidatedSelection } from './selection';

/**
 * "EXECUTE (deterministic — NO model involvement) → metric functions run under tenant context
 * (RLS enforced) → role-based filtering applied (Staff never receives cost metrics)." This is the
 * ONLY place a validated `PlanResult.selections` becomes a real `MetricResult` — no model touches
 * a number between here and the grounding bundle (I1), and every call goes through
 * `executeMetric`, the single path through which any metric is ever computed (I2). This function
 * adds no new permission logic of its own — `executeMetric` already enforces `requiredPermission`
 * unconditionally before `execute` ever runs; this function's only job is calling it under the
 * caller's REAL `AuthContext`/`MetricContext` (never a synthetic or elevated one) and turning its
 * outcomes into a typed, per-selection result.
 *
 * Results are PER-SELECTION, never all-or-nothing. A staff member asking a question that happens
 * to touch both an allowed metric and a cost metric gets a real answer for the part they're
 * allowed to see, plus an explicit, typed denial for the part they're not — "Staff asking about
 * margin gets a permission refusal, not data" is informative, not a reason to withhold an
 * otherwise-answerable question entirely. This mirrors `PlanResult`'s own `selections`/`rejected`
 * split.
 */
export type DeniedSelection = {
  metricId: string;
  reason: string;
};

export type FailedSelection = {
  metricId: string;
  reason: string;
};

export type ExecutionResult = {
  /** Real `MetricResult`s — the only things a future grounding bundle may ever include. */
  results: MetricResult[];
  /** A real, designed refusal (`MetricPermissionDeniedError`) — the caller lacks the metric's required permission. Never silently dropped; a future narration/refusal path explains this to the user by name. */
  denied: DeniedSelection[];
  /** An unexpected catalog error — e.g. `UnknownMetricError`, which should be unreachable in practice since planning already validates every selection's metricId against the same catalog, but `executeMetric` re-checks independently and this function does not assume that check can never fail differently in the future. */
  failed: FailedSelection[];
};

export const executeSelections = async (
  selections: ValidatedSelection[],
  auth: AuthContext,
  ctx: MetricContext
): Promise<ExecutionResult> => {
  const results: MetricResult[] = [];
  const denied: DeniedSelection[] = [];
  const failed: FailedSelection[] = [];

  for (const { metricId, params } of selections) {
    try {
      const result = await executeMetric(metricId, params, auth, ctx);
      results.push(result);
    } catch (e) {
      if (e instanceof MetricPermissionDeniedError) {
        denied.push({ metricId, reason: e.message });
      } else if (e instanceof UnknownMetricError) {
        failed.push({ metricId, reason: e.message });
      } else {
        failed.push({ metricId, reason: (e as Error).message });
      }
    }
  }

  return { results, denied, failed };
};
