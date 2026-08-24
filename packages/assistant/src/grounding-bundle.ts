import type { MetricResult } from '@retailos/metrics';

/**
 * The ONLY thing a narration prompt is ever given — never raw data rows (I1). Every number in an
 * assistant response must trace to a value inside this bundle; `validateGrounding` (not built yet)
 * is what enforces that. `metrics` reuses `packages/metrics`'s own `MetricResult` type directly
 * rather than a parallel shape — the whole point of the metric catalog is that the dashboard, the
 * API, and the assistant all read the exact same computed value (I2); defining a second,
 * assistant-specific result shape here would be the beginning of that guarantee quietly eroding.
 *
 * `passages` is filled by real hybrid retrieval and consumed by narration and the citation panel;
 * `entities` remains a placeholder shape for future entity-description search
 * — present now so `messages.groundingBundle`'s JSONB column has a real, stable type to validate
 * against from day one, rather than widening this type later in a way every earlier caller would
 * need to be revisited for.
 */
export type GroundingPassage = {
  sourceType: string;
  sourceId: string;
  text: string;
  score: number;
};

export type GroundingEntity = {
  entityType: string;
  entityId: string;
  label: string;
};

/**
 * A `MetricResult` plus the store it was computed for, when that matters.
 *
 * `MetricResult` carries no scope of its own. With several accessible stores, a question that names
 * none makes the planner call the same metric once per store, and the bundle then held three
 * identical `gross_revenue` entries distinguishable only by their values — so a live answer read
 * "we have three different figures recorded for gross revenue: 23,51,905.00, 14,44,310.00, and
 * 8,83,190.00", with no way to tell which outlet each belonged to.
 *
 * The label is attached here rather than added to `MetricResult` itself: every metric in the
 * catalog and the grounding validator depend on that type, and none of them need a store name. Only
 * narration does.
 */
export type GroundingBundle = {
  metrics: MetricResult[];
  /** Same length and order as `metrics` when present — narration reads it to name the store behind
   * each figure. Built in one pass alongside `metrics` so the two cannot drift apart. */
  metricScopes?: (string | undefined)[];
  passages: GroundingPassage[];
  entities: GroundingEntity[];
};
