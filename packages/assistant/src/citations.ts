import type { MetricResult } from '@retailos/metrics';
import { getMetric } from '@retailos/metrics';
import type { GroundingBundle, GroundingPassage } from './grounding-bundle';

/**
 * "Every response shows: figures with citations · 'how this was calculated' (metric definitions in
 * plain English) · freshness."
 *
 * This is a pure, deterministic projection of data the bundle ALREADY carries — `MetricResult`
 * has always returned `period`, `computedAt`, `freshness` and `provenance`, and the catalog has
 * always carried a plain-English `description` written in the words a user would say. Nothing here
 * is computed, inferred, or generated: a model is never consulted, so a citation cannot be
 * hallucinated. That is the whole point — a citation the model could invent would be worse than no
 * citation at all, because it would look like proof.
 *
 * Deliberately NOT a second description of what a metric means (I2). `explanation` is read straight
 * off the registered `MetricDefinition.description`; if a metric's plain-English meaning is wrong or
 * unclear, the fix belongs in the catalog entry every other consumer also reads, not here.
 */
export type MetricCitation = {
  metricId: string;
  /** The catalog's own plain-English definition. `null` when the metric isn't registered — never a
   * fabricated or guessed explanation. */
  explanation: string | null;
  /** The period the figure covers. A figure without its period is not a fact. */
  period: { from: Date; to: Date };
  /** As-of time of the underlying data. Equals `computedAt` for live queries today. */
  freshness: Date;
  computedAt: Date;
  /** Real source tables and row counts this figure was computed from. Empty is meaningful: it means
   * the metric reported no sources, not that sources were withheld. */
  sources: { table: string; rowCount: number }[];
  /** Total rows behind the figure — the single most useful "how much is this based on?" signal, and
   * the basis for a real small-sample caveat rather than an invented confidence score. */
  totalRowCount: number;
  /** Present only for an unknown figure, straight from the metric's own reason. */
  unknownReason?: string;
};

export type PassageCitation = {
  sourceType: string;
  sourceId: string;
  text: string;
  score: number;
};

export type CitationSet = {
  metrics: MetricCitation[];
  passages: PassageCitation[];
};

/**
 * Below this, a figure is worth flagging as thin evidence. Spec 10's own example of an honest
 * limitation is *"based on 14 reviews mentioning speed — a small sample"* — so the threshold sits
 * just above that number, and the caveat states the REAL row count rather than a vague
 * "low confidence". A caller that wants a different bar can read `totalRowCount` directly.
 */
export const SMALL_SAMPLE_ROW_THRESHOLD = 20;

const toCitation = (metric: MetricResult): MetricCitation => {
  const definition = getMetric(metric.metricId);
  const sources = metric.provenance.map((p) => ({ table: p.table, rowCount: p.rowCount }));
  return {
    metricId: metric.metricId,
    // `?? null`, never `?? metric.metricId` — a raw id dressed up as an explanation is a fabricated
    // explanation. An unregistered metric genuinely has no plain-English definition to show.
    explanation: definition?.description ?? null,
    period: { from: metric.period.from, to: metric.period.to },
    freshness: metric.freshness,
    computedAt: metric.computedAt,
    sources,
    totalRowCount: sources.reduce((sum, s) => sum + s.rowCount, 0),
    ...(metric.unknownReason !== undefined ? { unknownReason: metric.unknownReason } : {}),
  };
};

/**
 * Builds the full citation set for a bundle. Every metric gets a citation — including `'unknown'`
 * ones, which is deliberate: "we looked, over this exact period, across these exact tables, and
 * still could not tell you" is itself a citable, checkable claim, and hiding it would make an
 * unknown look like an oversight rather than a finding (I7).
 */
export const buildCitations = (bundle: GroundingBundle): CitationSet => ({
  metrics: bundle.metrics.map(toCitation),
  passages: bundle.passages.map((p: GroundingPassage) => ({
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    text: p.text,
    score: p.score,
  })),
});

/**
 * A real, stated limitation for a figure computed from very little data — or `null` when there is
 * genuinely nothing to caveat. Never a generated hedge: the sentence names the actual row count, so
 * a reader can judge the sample themselves instead of trusting an opaque confidence label.
 *
 * Returns `null` for an unknown figure — an unknown already carries its own `unknownReason`, and
 * adding "based on few rows" on top would imply a number exists that merely needs more support.
 */
export const smallSampleCaveat = (citation: MetricCitation): string | null => {
  if (citation.unknownReason !== undefined) return null;
  if (citation.sources.length === 0) return null;
  if (citation.totalRowCount >= SMALL_SAMPLE_ROW_THRESHOLD) return null;
  const rows = citation.totalRowCount;
  return `Based on ${rows} ${rows === 1 ? 'row' : 'rows'} — a small sample.`;
};
