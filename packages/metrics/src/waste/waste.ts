import { addMoney, money, zeroMoney, type Money } from '@retailos/domain';
import type { UnknownOr } from '../margin/margin.js';

/**
 * Waste & shrinkage metrics — the design, the 4 not already registered by `margin/margin.ts`
 * (`waste_value`/`waste_by_reason`'s underlying breakdown already exist there, built as part of
 * the 2026-08-06 dashboard detour). Every function here is pure: given already-fetched rows, it
 * computes one number — no database access, matching every other file in this package.
 */

/* ------------------------------------------------------------------ waste_percentage */

/**
 * `waste_percentage` = `waste_value / cogs`. `'unknown'` if either input is itself unknown, or if
 * `cogs` is zero (no denominator to divide by — never a fabricated 0% or infinite%).
 */
export const computeWastePercentage = (
  wasteValue: Money | 'unknown',
  cogs: Money | 'unknown'
): UnknownOr<number> => {
  if (wasteValue === 'unknown' || cogs === 'unknown') return 'unknown';
  if (cogs.amount.isZero()) return 'unknown';
  return wasteValue.amount.dividedBy(cogs.amount).times(100).toDecimalPlaces(2).toNumber();
};

/* ------------------------------------------------------------------ shrinkage_value / shrinkage_percentage */

export type VarianceLine = {
  /** Already frozen at count-submission time — `(counted − theoretical) × t0UnitCost`. */
  varianceValue: string;
};

/**
 * `shrinkage_value` = `Σ(counted − theoretical) × cost` from approved counts — the design's exact
 * formula, already computed and frozen per-line by `StockCountService.approveCount`
 * — so this function's only job is summing. A shortfall (`counted < theoretical`) yields a
 * NEGATIVE `varianceValue`; summing signed values (not absolute) is deliberate — a store with more
 * surplus than shortfall in a period has genuinely net-positive inventory drift, not shrinkage, and
 * collapsing that to an absolute value would misreport which direction the problem runs.
 *
 * No approved counts in the period is a real zero (nothing to report), never `'unknown'` — unlike
 * a costing figure, an empty count history isn't missing data, it's an honest "no counts happened."
 */
export const computeShrinkageValue = (lines: VarianceLine[], currency: Money['currency']): Money =>
  lines.reduce((sum, line) => addMoney(sum, money(line.varianceValue, currency)), zeroMoney(currency));

/**
 * `shrinkage_percentage` = `shrinkage_value / cogs`. `'unknown'` when `cogs` is unknown or zero —
 * same division-safety rule as `waste_percentage`. Deliberately NOT `Math.abs`-ed even though
 * `shrinkage_value` can be negative (net surplus) — the percentage should carry the same sign, so a
 * negative "shrinkage %" correctly reads as net-positive drift, not nonsensical negative loss.
 */
export const computeShrinkagePercentage = (
  shrinkageValue: Money,
  cogs: Money | 'unknown'
): UnknownOr<number> => {
  if (cogs === 'unknown') return 'unknown';
  if (cogs.amount.isZero()) return 'unknown';
  return shrinkageValue.amount.dividedBy(cogs.amount).times(100).toDecimalPlaces(2).toNumber();
};

/* ------------------------------------------------------------------ waste_by_reason (parameterized) / expired_value */

export type ReasonCodedWasteLine = {
  reasonCode: string;
  value: Money | 'unknown';
};

/**
 * `waste_by_reason`, parameterized by a single `reasonCode` (confirmed with the user: one metric
 * call per reason code, matching this catalog's fixed one-scalar-`value`-per-call contract, rather
 * than trying to carry an array in `MetricResult`). Same all-or-nothing costed-total rule every
 * other waste/COGS aggregate in this catalog uses: one matching line with an unknown cost makes the
 * whole total unknown, never a partial sum that understates the real loss for that reason.
 */
export const computeWasteValueForReason = (
  lines: ReasonCodedWasteLine[],
  reasonCode: string,
  currency: Money['currency']
): UnknownOr<Money> => {
  const matching = lines.filter((line) => line.reasonCode === reasonCode);
  if (matching.some((line) => line.value === 'unknown')) return 'unknown';
  return matching.reduce((sum, line) => addMoney(sum, line.value as Money), zeroMoney(currency));
};

/**
 * `expired_value` = `waste_by_reason` called with `reasonCode: 'EXPIRED'` — the design registers it
 * as its own distinct metric id with its own grain (`store/product/period`, not `store/period`),
 * but the computation is identical, so this is a thin named wrapper rather than a duplicated body.
 */
export const computeExpiredValue = (
  lines: ReasonCodedWasteLine[],
  currency: Money['currency']
): UnknownOr<Money> => computeWasteValueForReason(lines, 'EXPIRED', currency);
