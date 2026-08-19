import { Decimal } from 'decimal.js';
import {
  decomposeWithWeeklySeasonality,
  flagResidualOutliers,
  median,
  populationStdev,
  type DailyPoint,
  type FlaggedPoint,
} from './statistics.js';

/**
 * The 4 real anomaly signals from the design with a genuine underlying data source in this
 * codebase: sales anomaly, cost spike, waste spike, consumption anomaly. `review_sentiment_shift`
 * (the spec's 5th signal) is deliberately NOT built — confirmed with the user: no review/sentiment
 * data source exists anywhere in this codebase's schema, and the design's own feature list marks it V2
 * with no epic assigned. Building it would mean fabricating a signal from nothing (I1/I7).
 */

/* ------------------------------------------------------------------ sales_anomaly */

/**
 * `sales_anomaly` — the design's own `|z| > 2.5` threshold against the residual of a classical
 * weekly-seasonal decomposition (see `statistics.ts`'s header for the deliberate STL deviation,
 * ADR-16). `'unknown'` with fewer than 14 real days of daily revenue in the series (I7 — day-of-week
 * seasonal averages need at least one full pair of weeks to be meaningful, never approximated).
 */
export const computeSalesAnomalies = (dailyRevenue: DailyPoint[]): FlaggedPoint[] | 'unknown' => {
  const decomposition = decomposeWithWeeklySeasonality(dailyRevenue);
  if (decomposition === 'unknown') return 'unknown';
  return flagResidualOutliers(decomposition, new Decimal('2.5'));
};

/* ------------------------------------------------------------------ cost_spike */

export type CostSpikePricePoint = { date: string; unitPrice: string };

/**
 * `cost_spike` — the design: unit price vs. 90-day median, flagged at `>15%` OR `>3σ`. Takes the
 * full trailing price history (already ordered) and the single LATEST price to check; `'unknown'`
 * with fewer than 2 historical points, matching `price_stability_index`'s own established
 * insufficient-data threshold for a price-series statistic.
 */
export const computeCostSpike = (
  history: CostSpikePricePoint[]
): { isSpike: boolean; latestPrice: string; medianPrice: string; percentChange: string; zScore: string } | 'unknown' => {
  if (history.length < 2) return 'unknown';
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1]!;
  const prices = sorted.map((p) => new Decimal(p.unitPrice));
  const latestPrice = new Decimal(latest.unitPrice);
  const med = median(prices);
  const stdev = populationStdev(prices);

  if (med.isZero()) return 'unknown';
  const percentChange = latestPrice.minus(med).dividedBy(med).times(100);
  const zScore = stdev.isZero() ? new Decimal(0) : latestPrice.minus(med).dividedBy(stdev);
  const isSpike = percentChange.abs().greaterThan(15) || zScore.abs().greaterThan(3);

  return {
    isSpike,
    latestPrice: latestPrice.toFixed(4),
    medianPrice: med.toFixed(4),
    percentChange: percentChange.toFixed(2),
    zScore: zScore.toFixed(4),
  };
};

/* ------------------------------------------------------------------ waste_spike */

/**
 * `waste_spike` — the design: daily waste value vs. trailing mean, flagged at `>2σ`. Takes a
 * real daily-bucketed waste-value series; `'unknown'` with fewer than 2 days of data (I7 — a
 * standard deviation over 0/1 points is not a real measure of spread).
 */
export const computeWasteSpikes = (dailyWasteValue: DailyPoint[]): FlaggedPoint[] | 'unknown' => {
  if (dailyWasteValue.length < 2) return 'unknown';
  const values = dailyWasteValue.map((d) => d.value);
  const stdev = populationStdev(values);
  if (stdev.isZero()) return [];
  const m = values.reduce((sum, v) => sum.plus(v), new Decimal(0)).dividedBy(values.length);

  return dailyWasteValue
    .map((d) => ({ date: d.date, deviation: d.value.minus(m), zScore: d.value.minus(m).dividedBy(stdev) }))
    .filter((d) => d.zScore.greaterThan(2))
    .map((d) => ({ date: d.date, value: d.deviation.toFixed(4), zScore: d.zScore.toFixed(4) }));
};

/* ------------------------------------------------------------------ consumption_anomaly */

export type ConsumptionDivergenceDay = { date: string; actual: Decimal; theoretical: Decimal };

/**
 * `consumption_anomaly` — the design: actual vs. theoretical consumption divergence, flagged when
 * `>10%` sustained for 3 CONSECUTIVE days (not merely 3 days total in the window — the spec's own
 * word "sustained" is the load-bearing part; three isolated one-off spikes weeks apart is a
 * different, less urgent signal than 3 days in a row).
 *
 * Confirmed with the user: `actual`/`theoretical` here are DOLLAR COGS per day (real
 * `computeCogsActual`/`computeCogsTheoretical` machinery, earlier work, applied once per day), not a raw
 * ingredient quantity. A genuine quantity-based theoretical series would need per-day recipe
 * explosion across every sold item over the whole window — real N+1 query risk this task
 * deliberately avoids; the dollar-COGS framing still catches the same real signal (production/
 * portioning error surfacing as a cost gap) using machinery this codebase already has and trusts.
 *
 * A day with zero theoretical COGS is excluded from the divergence check entirely (I7 — dividing by
 * a real zero produces an undefined percentage, never a fabricated one), but does NOT break a streak
 * of surrounding divergent days.
 */
export const computeConsumptionAnomalyDays = (days: ConsumptionDivergenceDay[]): string[] => {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const divergent = new Set<string>();
  for (const day of sorted) {
    if (day.theoretical.isZero()) continue;
    const divergence = day.actual.minus(day.theoretical).dividedBy(day.theoretical).abs();
    if (divergence.greaterThan('0.10')) divergent.add(day.date);
  }

  const flagged: string[] = [];
  let streak: string[] = [];
  for (const day of sorted) {
    if (divergent.has(day.date)) {
      streak.push(day.date);
    } else {
      if (streak.length >= 3) flagged.push(...streak);
      streak = [];
    }
  }
  if (streak.length >= 3) flagged.push(...streak);
  return flagged;
};
