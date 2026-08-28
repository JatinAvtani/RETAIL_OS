import Decimal from 'decimal.js';
import type { MetricResult } from '@retailos/metrics';
import type { GroundingBundle } from './grounding-bundle';

/**
 * The deterministic half of the daily briefing: "compute exceptions → rank by dollar impact → top
 * 3–6 → LLM writes only the connective prose; every figure comes from a metric call."
 *
 * **Ranking, honestly.** The instruction says "rank by dollar impact", but only a minority of the
 * exception metrics this system registers are monetary at all (`expiry_risk_value`,
 * `dead_stock_value`, `shrinkage_value`… are `CURRENCY`; `documents_pending_review`,
 * `negative_stock_incidents`, `sales_anomaly`… are `COUNT`). Assigning a dollar figure to a count
 * would require inventing a per-unit cost this system does not have — a fabricated business number,
 * exactly what I1/I7 exist to prevent. So ranking is **tiered**: real monetary impact ranks first
 * and is ordered by its genuine amount; non-monetary exceptions rank beneath, ordered by declared
 * severity. A count never fabricates its way above a real dollar figure, and a real dollar figure is
 * never invented for a count.
 *
 * This module computes NO business numbers of its own (I2). It receives already-executed
 * `MetricResult`s from the caller — the same values the dashboard's own exception feed reads — and
 * only filters, ranks and slices them. `toBriefingBundle` then hands the survivors to the SAME
 * `narrateAndValidate` gate every other narration path uses, so the briefing inherits the numeric
 * validator wholesale rather than re-implementing a weaker one.
 */
export type BriefingSeverity = 'danger' | 'warning';

/**
 * One candidate exception, as supplied by the caller. `result` is the real executed metric — the
 * single source of the figure (I2); `label` is the caller's own already-written plain description,
 * NOT generated here.
 */
export type BriefingCandidate = {
  id: string;
  severity: BriefingSeverity;
  label: string;
  result: MetricResult;
  /**
   * The store this candidate's metric was scoped to, for `narration.ts`'s `metricScopes` (which
   * names the store behind each figure). `undefined` for a genuinely store-scoped candidate whose
   * caller didn't resolve a name (rare — most callers know the store they're briefing), but an
   * ORG-WIDE metric (e.g. `stock_projection_drift` called with no storeId) must set this
   * explicitly rather than leaving it `undefined`, which reads as "scope unknown," not "no store
   * applies." Distinguishing those two is the whole reason this field exists: a store's own daily
   * briefing silently including an org-wide figure with no label looks like it's about that one
   * store, which is a real misattribution once a second store exists.
   */
  scope?: string;
};

export type RankedException = BriefingCandidate & {
  /** The real monetary amount behind this exception, or `null` when it genuinely has none. Never a
   * derived or estimated stand-in for a count. */
  monetaryImpact: string | null;
};

/** Spec: "top 3–6". The upper bound is the real cap; fewer is fine when fewer are genuine. */
export const MAX_BRIEFING_ITEMS = 6;

const SEVERITY_RANK: Record<BriefingSeverity, number> = { danger: 0, warning: 1 };

/**
 * A candidate counts as an exception only when its metric produced a REAL, non-zero value. An
 * `'unknown'` metric is deliberately excluded rather than surfaced as a zero-impact item: "we could
 * not compute this" is a genuine finding, but it is a data-completeness problem, not an exception
 * about the business — conflating the two would let a broken pipeline read as a calm day (I7).
 */
const isRealException = (candidate: BriefingCandidate): boolean => {
  const { value } = candidate.result;
  if (value === 'unknown') return false;
  try {
    return new Decimal(value).greaterThan(0);
  } catch {
    return false;
  }
};

const monetaryImpactOf = (candidate: BriefingCandidate): string | null =>
  candidate.result.unit === 'CURRENCY' && candidate.result.value !== 'unknown' ? candidate.result.value : null;

/**
 * Ranks real exceptions and returns at most `MAX_BRIEFING_ITEMS`. Pure and total — no I/O, no model,
 * no clock — so the ordering is fully testable and identical for identical inputs.
 */
export const rankExceptions = (candidates: BriefingCandidate[]): RankedException[] =>
  candidates
    .filter(isRealException)
    .map((candidate) => ({ ...candidate, monetaryImpact: monetaryImpactOf(candidate) }))
    .sort((a, b) => {
      // Tier 1: anything with a real dollar figure outranks anything without one.
      if (a.monetaryImpact !== null && b.monetaryImpact === null) return -1;
      if (a.monetaryImpact === null && b.monetaryImpact !== null) return 1;
      // Within the monetary tier, the larger real amount comes first.
      if (a.monetaryImpact !== null && b.monetaryImpact !== null) {
        const diff = new Decimal(b.monetaryImpact).comparedTo(new Decimal(a.monetaryImpact));
        if (diff !== 0) return diff;
      } else {
        // Within the non-monetary tier, declared severity decides — never a fabricated dollar proxy.
        const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
        if (bySeverity !== 0) return bySeverity;
      }
      // Deterministic tie-break so equal-ranking exceptions never reorder between runs.
      return a.id.localeCompare(b.id);
    })
    .slice(0, MAX_BRIEFING_ITEMS);

/**
 * Projects ranked exceptions into a real `GroundingBundle` so the briefing can be narrated by the
 * SAME `narrateAndValidate` path every other answer uses. This is the whole reason the briefing
 * needs no safety code of its own: the model is handed only these already-computed values, and any
 * number it emits that isn't among them is caught by the existing numeric validator.
 */
export const toBriefingBundle = (ranked: RankedException[]): GroundingBundle => ({
  metrics: ranked.map((r) => r.result),
  metricScopes: ranked.map((r) => r.scope),
  passages: [],
  entities: [],
});
