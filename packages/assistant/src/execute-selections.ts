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
  /** Same length and order as `results`: the store name each was computed for, when the selection
   * carried a `storeId`. `MetricResult` has no scope of its own, so without this a question that
   * fans out across several stores produces indistinguishable figures. */
  resultScopes: (string | undefined)[];
  /** A real, designed refusal (`MetricPermissionDeniedError`) — the caller lacks the metric's required permission. Never silently dropped; a future narration/refusal path explains this to the user by name. */
  denied: DeniedSelection[];
  /** An unexpected catalog error — e.g. `UnknownMetricError`, which should be unreachable in practice since planning already validates every selection's metricId against the same catalog, but `executeMetric` re-checks independently and this function does not assume that check can never fail differently in the future. */
  failed: FailedSelection[];
};

export const executeSelections = async (
  selections: ValidatedSelection[],
  auth: AuthContext,
  ctx: MetricContext,
  /** Real store names by id, for labelling. Absent for callers that do not resolve stores. */
  storeNamesById?: Map<string, string>
): Promise<ExecutionResult> => {
  const results: MetricResult[] = [];
  const resultScopes: (string | undefined)[] = [];
  const denied: DeniedSelection[] = [];
  const failed: FailedSelection[] = [];

  for (const { metricId, params } of selections) {
    try {
      const result = await executeMetric(metricId, params, auth, ctx);
      results.push(result);
      // Pushed in the SAME step as the result, so the two arrays cannot drift apart.
      const storeId = params.storeId;
      resultScopes.push(typeof storeId === 'string' ? storeNamesById?.get(storeId) : undefined);
    } catch (e) {
      if (e instanceof MetricPermissionDeniedError) {
        denied.push({ metricId, reason: e.message });
      } else if (e instanceof UnknownMetricError) {
        // A designed, safe error whose message is just "no metric with id X" — nothing
        // data-derived, so it's fine to relay verbatim (unlike the branch below).
        failed.push({ metricId, reason: e.message });
      } else {
        // An UNEXPECTED error — could be a raw Postgres driver error carrying SQL text, column
        // names, or param values. `FailedSelection.reason` is prose the model is explicitly
        // ALLOWED to relay to the user verbatim (narration.ts's own formatGaps), so putting a raw
        // exception message here would leak internals through the assistant. It also risks an
        // outage: if the model echoes a number from that leaked message, the grounding validator
        // has no allowlist entry for it (denied/failed reason numbers are deliberately excluded —
        // validate-grounding.ts's own doc comment) and discards the whole narration. Log the real
        // error server-side where an operator can see it; the user gets a stable, honest,
        // non-leaking phrase instead.
        console.error(`executeSelections: metric '${metricId}' failed with an unexpected error`, e);
        failed.push({ metricId, reason: 'An internal error occurred while computing this.' });
      }
    }
  }

  return { results, resultScopes, denied, failed };
};
