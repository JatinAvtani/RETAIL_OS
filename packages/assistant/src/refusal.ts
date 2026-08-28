import type { GroundingBundle } from './grounding-bundle';
import type { DeniedSelection, FailedSelection } from './execute-selections';
import type { RejectedSelection } from './planning';

/**
 * The design's "refuse if insufficient" is currently satisfied only by `narrate`'s own
 * free-text prompt instruction — real and honest, but unstructured LLM prose, not the "designed,
 * tested output path" I7 calls for. Spec 10's own literal example
 * (*"I can't compute margin for Flat White because it has no recipe. Add one here and I'll be
 * able to answer."*) has two real components: WHAT is missing, and a concrete, actionable NEXT
 * STEP — this function derives both deterministically (zero model involvement) from the same real
 * gap data `narrate` already reads (`MetricResult.unknownReason`, `DeniedSelection`/
 * `FailedSelection`/`RejectedSelection`), so a caller (a future UI, an eval assertion, or `narrate`
 * itself) can get a structured, testable answer without needing a live model call to know a
 * question was unanswerable and why.
 *
 * `remedy` is derived by matching each real reason string against a small set of known, genuinely
 * actionable gap classes (no recipe, no supplier price, permission denied, unregistered metric).
 * These classes are pattern-matched against the metric catalog's own existing free-text
 * `unknownReason` messages rather than requiring every metric to also emit a separate structured
 * error code — the messages already exist and are the real source of truth (I2: this must not
 * become a second, drifting description of the same gap). **A reason that matches no known
 * class still gets a real, honest remedy — "no specific fix is known; try a different question or
 * a narrower date range" — never a fabricated or overly specific instruction the system has no
 * actual basis for.**
 */
export type RefusalCategory = 'unknown_metric_value' | 'permission_denied' | 'execution_failed' | 'invalid_selection';

export type RefusalItem = {
  metricId: string;
  category: RefusalCategory;
  reason: string;
  remedy: string;
};

export type RefusalInfo = {
  /** True only when NOTHING in the bundle can answer the question at all — every requested
   * selection ended up as a gap. A caller with at least one real metric value alongside some gaps
   * is NOT fully refused; it has a partial answer plus a partial explanation (matching
   * `executeSelections`'s own per-selection, never all-or-nothing design). */
  fullyUnanswerable: boolean;
  items: RefusalItem[];
};

const GENERIC_REMEDY = 'No specific fix is known for this — try rephrasing the question or asking about a narrower date range.';

const remedyForUnknownReason = (reason: string): string => {
  const lower = reason.toLowerCase();
  if (lower.includes('no recipe') || lower.includes('linked recipe')) {
    return 'Add or link a recipe for this menu item, then ask again.';
  }
  if (
    lower.includes('no currently-effective price') ||
    lower.includes('no known cost') ||
    lower.includes('no known average cost') ||
    lower.includes('no stock movement has ever recorded a cost') ||
    lower.includes('no fully-resolvable confirmed supplier price') ||
    lower.includes('resolvable cost') ||
    (lower.includes('cogs') && (lower.includes('unknown') || lower.includes('zero')))
  ) {
    return 'Record a supplier price or a stock receipt with a real cost for this product, then ask again.';
  }
  if (lower.includes('not found')) {
    return 'Check the name or id and try again — this does not currently exist.';
  }
  if (
    lower.includes('no completed') ||
    lower.includes('no sales') ||
    lower.includes('no gross revenue') ||
    lower.includes('no transactions') ||
    lower.includes('no sale_consumption') ||
    lower.includes('no mapped menu items sold')
  ) {
    return 'There is no sales activity in this period yet — try a different date range.';
  }
  if (lower.includes('no purchase order') || lower.includes('no goods receipt')) {
    return 'There is no purchasing activity in this period yet — try a different date range.';
  }
  if (
    lower.includes('fill_complete') ||
    lower.includes('delivery_on_time') ||
    lower.includes('invoice_clean') ||
    lower.includes('po-linked receipt')
  ) {
    return 'This supplier has no recorded delivery/fill/invoice outcomes for this period yet — record a goods receipt against a purchase order, then ask again.';
  }
  if (lower.includes('never completed a successful sync')) {
    return 'This integration has not completed a sync yet — check its connection status, then ask again.';
  }
  if (lower.includes('no documents are currently awaiting review')) {
    return 'This is a genuinely calm result, not a gap — there is nothing pending review right now.';
  }
  if (lower.includes('no document extractions exist yet')) {
    return 'Upload an invoice or receipt document to get started, then ask again.';
  }
  return GENERIC_REMEDY;
};

const remedyForCategory = (category: RefusalCategory, reason: string): string => {
  switch (category) {
    case 'unknown_metric_value':
      return remedyForUnknownReason(reason);
    case 'permission_denied':
      return 'Ask someone with the required permission, or request access.';
    case 'invalid_selection':
      return 'This could not be understood as a valid question for the metric catalog — try rephrasing it.';
    case 'execution_failed':
      return GENERIC_REMEDY;
  }
};

const item = (metricId: string, category: RefusalCategory, reason: string): RefusalItem => ({
  metricId,
  category,
  reason,
  remedy: remedyForCategory(category, reason),
});

export const buildRefusal = (
  bundle: GroundingBundle,
  denied: DeniedSelection[],
  failed: FailedSelection[],
  rejected: RejectedSelection[],
  /** True when the question was classified as needing a metric. Lets an unanswerable METRIC
   * question produce a real refusal without changing the empty-bundle contract for every other
   * caller. */
  expectedMetrics = false
): RefusalInfo | null => {
  const answeredCount = bundle.metrics.filter((m) => m.value !== 'unknown').length;

  const items: RefusalItem[] = [
    ...bundle.metrics.filter((m) => m.value === 'unknown').map((m) => item(m.metricId, 'unknown_metric_value', m.unknownReason ?? 'This could not be computed for an unspecified reason.')),
    ...denied.map((d) => item(d.metricId, 'permission_denied', d.reason)),
    ...failed.map((f) => item(f.metricId, 'execution_failed', f.reason)),
    ...rejected.map((r) => item(r.metricId, 'invalid_selection', r.reason)),
  ];

  // A METRIC question the planner could not map onto ANY catalog metric — asking for customer
  // lifetime value, say, which this product does not compute. Nothing is denied, failed, or
  // rejected because nothing was ever selected, so without this the caller gets a silently empty
  // bundle and no explanation. Saying "there is no metric for this" is the honest answer; saying
  // nothing invites the reader to assume the figure is zero or the data is missing.
  //
  // Gated on `expectedMetrics` rather than on emptiness alone: an empty bundle is also the NORMAL
  // shape for a retrieval question that found no passages, and for a caller that deliberately
  // requested nothing. Only the caller knows the question was meant to produce a metric.
  if (expectedMetrics && items.length === 0 && bundle.metrics.length === 0 && bundle.passages.length === 0) {
    return {
      fullyUnanswerable: true,
      items: [
        item(
          'none',
          'invalid_selection',
          'No metric in the catalog computes this, so there is no figure to report.'
        ),
      ],
    };
  }

  if (items.length === 0) {
    return null;
  }

  return { fullyUnanswerable: answeredCount === 0, items };
};
