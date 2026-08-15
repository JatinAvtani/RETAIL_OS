import { Decimal } from 'decimal.js';
import type { UnknownOr } from '../margin/margin.js';

/**
 * Supplier metrics (spec 12 §G) with genuinely NEW compute logic — the 3 of the section's 8 that
 * `supplier-performance.ts` (008-13/008-15) doesn't already cover: `lead_time_actual`,
 * `lead_time_variance`, `price_stability_index`. `fill_rate`/`on_time_delivery_rate`/
 * `invoice_accuracy_rate`/`quality_reject_rate` reuse that file's existing, already-tested
 * functions directly — see `catalog-entries.ts` for the thin `defineMetric` wrappers around them.
 * `effective_unit_cost` (the 8th) remains deliberately unbuilt — that file's own header comment
 * explains why (no delivery-fee/credit data exists anywhere in this codebase, I7), and nothing
 * about that has changed.
 */

/* ------------------------------------------------------------------ lead_time_actual / lead_time_variance */

export type LeadTimeLine = {
  sentAt: Date;
  receivedAt: Date;
};

const leadTimeDays = (lines: LeadTimeLine[]): Decimal[] =>
  lines.map((line) => new Decimal(line.receivedAt.getTime() - line.sentAt.getTime()).dividedBy(1000 * 60 * 60 * 24));

/**
 * `lead_time_actual` = mean days from a PO being sent to the resulting receipt. `'unknown'` with
 * zero real (PO-linked, sent) receipts in the period (I7 — never a fabricated 0-day average).
 */
export const computeLeadTimeActual = (lines: LeadTimeLine[]): UnknownOr<number> => {
  if (lines.length === 0) return 'unknown';
  const days = leadTimeDays(lines);
  const mean = days.reduce((sum, d) => sum.plus(d), new Decimal(0)).dividedBy(days.length);
  return mean.toDecimalPlaces(2).toNumber();
};

/**
 * `lead_time_variance` = population standard deviation of the same per-receipt lead times
 * `lead_time_actual` averages — "stdev of the above" per spec's own literal wording. `'unknown'`
 * with fewer than 2 data points (I7 — a standard deviation over 0 or 1 points is not a real
 * measure of spread, never fabricated as 0).
 */
export const computeLeadTimeVariance = (lines: LeadTimeLine[]): UnknownOr<number> => {
  if (lines.length < 2) return 'unknown';
  const days = leadTimeDays(lines);
  const mean = days.reduce((sum, d) => sum.plus(d), new Decimal(0)).dividedBy(days.length);
  const variance = days.reduce((sum, d) => sum.plus(d.minus(mean).pow(2)), new Decimal(0)).dividedBy(days.length);
  return variance.sqrt().toDecimalPlaces(2).toNumber();
};

/* ------------------------------------------------------------------ price_stability_index */

export type PriceHistoryPoint = {
  unitPrice: string;
};

/**
 * `price_stability_index` = coefficient of variation (`stdev / mean`) of unit price over one
 * supplier product's real effective-dated price history (spec 12 §G) — confirmed with the user:
 * parameterized per `supplierProductId`, not blended across a supplier's unrelated products, since
 * no formula in the spec says how to combine price series at genuinely different price scales.
 * `'unknown'` with fewer than 2 price points (I7 — variation is undefined over a single price) or
 * when the mean price is zero (an undefined ratio, never a fabricated infinite/zero index).
 */
export const computePriceStabilityIndex = (points: PriceHistoryPoint[]): UnknownOr<number> => {
  if (points.length < 2) return 'unknown';
  const prices = points.map((p) => new Decimal(p.unitPrice));
  const mean = prices.reduce((sum, p) => sum.plus(p), new Decimal(0)).dividedBy(prices.length);
  if (mean.isZero()) return 'unknown';
  const variance = prices.reduce((sum, p) => sum.plus(p.minus(mean).pow(2)), new Decimal(0)).dividedBy(prices.length);
  const stdev = variance.sqrt();
  return stdev.dividedBy(mean).toDecimalPlaces(4).toNumber();
};
