import { Decimal } from 'decimal.js';

/**
 * Shared statistical primitives for anomaly detection. Every function
 * here is pure — no database access, matching every other domain in this package.
 *
 * ADR-16 (docs/spec/18-engineering-decisions.md) records a deliberate deviation from the spec's
 * literal "STL decomposition" wording for `sales_anomaly`: a classical decomposition (moving-average
 * trend, day-of-week seasonal averages, residual z-score) achieves the spec's actual stated goal —
 * day-of-week-aware anomaly detection with a tunable threshold — with arithmetic simple enough to
 * hand-verify, matching this project's own "if you can't verify it by hand, it's too complex to
 * trust" standard. No loess-based STL library exists in this monorepo and none is
 * added for this.
 */

export const mean = (values: Decimal[]): Decimal =>
  values.reduce((sum, v) => sum.plus(v), new Decimal(0)).dividedBy(values.length);

/** Population standard deviation — same formula already hand-verified in `supplier-metrics.ts`. */
export const populationStdev = (values: Decimal[]): Decimal => {
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum.plus(v.minus(m).pow(2)), new Decimal(0)).dividedBy(values.length);
  return variance.sqrt();
};

/** The median of a real (non-empty) set of values — linear interpolation is not used; the classical "average the two middle values on an even count" definition is. */
export const median = (values: Decimal[]): Decimal => {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return sorted[mid - 1]!.plus(sorted[mid]!).dividedBy(2);
  }
  return sorted[mid]!;
};

/** A single day's real value in a time series — the shared input shape every daily-series detector below builds from. */
export type DailyPoint = { date: string; value: Decimal };

export type SeasonalDecomposition = {
  date: string;
  actual: Decimal;
  trend: Decimal | null;
  seasonal: Decimal | null;
  residual: Decimal | null;
};

/**
 * Classical additive decomposition: `actual = trend + seasonal + residual`.
 *
 * `trend[t]` is a centered 7-day moving average around day `t` — undefined (`null`) for the first
 * and last 3 days of the series, where a full centered window doesn't exist (never approximated
 * with a shorter, biased window — I7 applied to a statistical primitive, not just a business
 * number).
 *
 * `seasonal[weekday]` is the mean of `(actual - trend)` across every day in the series sharing that
 * weekday — the real, data-derived day-of-week effect (e.g. "Saturdays really do run high"), not an
 * assumed constant.
 *
 * `residual[t] = actual[t] - trend[t] - seasonal[weekday(t)]` — what's left after removing both the
 * slow trend and the repeating weekly pattern. This is what gets z-scored for anomaly flagging.
 *
 * Requires at least 14 real days (two full weeks) — fewer makes the day-of-week seasonal averages
 * unreliable (some weekdays would have only 1 data point).
 */
export const decomposeWithWeeklySeasonality = (series: DailyPoint[]): SeasonalDecomposition[] | 'unknown' => {
  if (series.length < 14) return 'unknown';
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));

  const trends: (Decimal | null)[] = sorted.map((_, i) => {
    if (i < 3 || i >= sorted.length - 3) return null;
    const window = sorted.slice(i - 3, i + 4);
    return mean(window.map((p) => p.value));
  });

  const weekdayOf = (dateStr: string): number => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

  const deviationsByWeekday = new Map<number, Decimal[]>();
  sorted.forEach((point, i) => {
    const trend = trends[i] ?? null;
    if (trend === null) return;
    const weekday = weekdayOf(point.date);
    const deviation = point.value.minus(trend);
    const existing = deviationsByWeekday.get(weekday) ?? [];
    existing.push(deviation);
    deviationsByWeekday.set(weekday, existing);
  });

  const seasonalByWeekday = new Map<number, Decimal>();
  for (const [weekday, deviations] of deviationsByWeekday) {
    seasonalByWeekday.set(weekday, mean(deviations));
  }

  return sorted.map((point, i) => {
    const trend = trends[i] ?? null;
    const seasonal = seasonalByWeekday.get(weekdayOf(point.date)) ?? null;
    const residual = trend !== null && seasonal !== null ? point.value.minus(trend).minus(seasonal) : null;
    return { date: point.date, actual: point.value, trend, seasonal, residual };
  });
};

export type FlaggedPoint = { date: string; value: string; zScore: string };

/**
 * Flags every day whose residual's z-score exceeds `threshold` in absolute value — the design's
 * own `|z| > 2.5` for sales anomalies. A z-score is `(x - mean) / stdev`, not `x / stdev` — computed
 * over the population mean/stdev of every real (non-null) residual in the series, not a per-day
 * rolling window, matching `computeLeadTimeVariance`/`computePriceStabilityIndex`'s existing
 * population-stdev precedent in this codebase. Demeaning matters even though a decomposition's
 * residuals are CONCEPTUALLY centered near zero when trend/seasonal fully explain the pattern — in
 * a small, finite sample a genuine outlier itself pulls the raw mean away from zero, and skipping
 * the subtraction would silently understate that same outlier's own z-score (caught by a test with
 * exactly this shape: a lone spike among four small residuals).
 */
export const flagResidualOutliers = (decomposition: SeasonalDecomposition[], threshold: Decimal): FlaggedPoint[] => {
  const residuals = decomposition.map((d) => d.residual).filter((r): r is Decimal => r !== null);
  if (residuals.length < 2) return [];
  const residualMean = mean(residuals);
  const stdev = populationStdev(residuals);
  if (stdev.isZero()) return [];

  return decomposition
    .filter((d) => d.residual !== null)
    .map((d) => ({
      date: d.date,
      residual: d.residual as Decimal,
      zScore: (d.residual as Decimal).minus(residualMean).dividedBy(stdev),
    }))
    .filter((d) => d.zScore.abs().greaterThan(threshold))
    .map((d) => ({ date: d.date, value: d.residual.toFixed(6), zScore: d.zScore.toFixed(4) }));
};
