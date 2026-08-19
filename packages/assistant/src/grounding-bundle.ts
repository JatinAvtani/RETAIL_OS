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

export type GroundingBundle = {
  metrics: MetricResult[];
  passages: GroundingPassage[];
  entities: GroundingEntity[];
};
