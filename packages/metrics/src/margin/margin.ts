import {
  addMoney,
  compareMoney,
  subtractMoney,
  zeroMoney,
  type Money,
} from '@retailos/domain';
import Decimal from 'decimal.js';

/**
 * The margin metrics — the output end of the costing chain, and the numbers this product exists to
 * produce. Every function here is pure: it is given already-fetched, already-resolved values and
 * computes one number. No database access, no unit conversion, no price lookup — those happen at
 * the boundary before these are called, exactly as `computeRecipeCost` established.
 *
 * These are the sole registered place each of these numbers is computed. A route handler, a
 * dashboard, or (later) the AI assistant must call these rather than summing values themselves —
 * otherwise two consumers eventually disagree about "food cost %", and the moment a user sees two
 * different values for the same thing, every number loses credibility.
 *
 * The recurring rule throughout: a number that cannot be computed returns `'unknown'`, never a
 * zero and never a partial sum. `cogs_actual` missing one lot's cost is not "mostly right" — it is
 * a figure that cannot be stated, and stating it anyway silently overstates margin.
 */

/** A single consumption event, with the real cost of the lot it was actually drawn from. */
export type ConsumptionLine = {
  productId: string;
  quantity: string;
  /** `'unknown'` when the lot carried no known cost — never coerced to zero. */
  cost: Money | 'unknown';
};

/** One sold menu item and the theoretical cost of its recipe at the time it sold. */
export type SoldItemLine = {
  menuItemId: string;
  quantitySold: string;
  /** `'unknown'` when the recipe's cost could not be fully resolved (see `computeRecipeCost`). */
  unitRecipeCost: Money | 'unknown';
};

export type UnknownOr<T> = T | 'unknown';

/* ------------------------------------------------------------------ revenue */

/**
 * `net_revenue` — the sum of line totals already net of discounts, as recorded by the POS. We do
 * not recompute the vendor's own arithmetic: their rounding produced the receipt the customer
 * holds, and disagreeing with it by a cent is a support problem, not a correctness win.
 *
 * An empty period genuinely has zero revenue — nothing was sold. That is a real, knowable zero,
 * distinct from an unknown, so this returns `Money`, not `UnknownOr<Money>`.
 */
export const computeNetRevenue = (lineTotals: Money[], currency: Money['currency']): Money =>
  lineTotals.reduce((sum, line) => addMoney(sum, line), zeroMoney(currency));

/* ------------------------------------------------------------------ COGS */

/**
 * `cogs_actual` — what the consumed stock genuinely cost, taken from the lots FEFO actually drew
 * from. If ANY consumed line has an unknown lot cost, the total is unknown: a partial sum would
 * understate COGS and therefore overstate margin, which is the specific failure this codebase is
 * built to prevent.
 */
export const computeCogsActual = (
  lines: ConsumptionLine[],
  currency: Money['currency']
): UnknownOr<Money> => {
  if (lines.some((line) => line.cost === 'unknown')) return 'unknown';
  return lines.reduce((sum, line) => addMoney(sum, line.cost as Money), zeroMoney(currency));
};

/**
 * `cogs_theoretical` — what the sold items *should* have cost, from recipe costs. Same
 * all-or-nothing rule: one unresolvable recipe cost makes the period's theoretical COGS unknown,
 * because the variance computed against a partial figure would be a fabricated number.
 */
export const computeCogsTheoretical = (
  lines: SoldItemLine[],
  currency: Money['currency']
): UnknownOr<Money> => {
  if (lines.some((line) => line.unitRecipeCost === 'unknown')) return 'unknown';
  return lines.reduce((sum, line) => {
    const unitCost = line.unitRecipeCost as Money;
    const lineCost = unitCost.amount.times(new Decimal(line.quantitySold));
    return addMoney(sum, { amount: lineCost, currency: unitCost.currency } as Money);
  }, zeroMoney(currency));
};

/* ------------------------------------------------------------------ variance & margin */

export type CostVarianceResult = {
  variance: UnknownOr<Money>;
  /**
   * Positive variance means actual exceeded theoretical — stock left the building that recipes
   * don't account for. Negative means less was consumed than recipes predicted, which usually
   * points at over-portioning in the recipe itself or an unrecorded receipt, not a windfall.
   */
  direction: 'over' | 'under' | 'exact' | 'unknown';
};

/**
 * `cost_variance` = `cogs_actual − cogs_theoretical`. The gap between what was consumed and what
 * should have been consumed: waste, shrinkage, theft, and portioning error combined. This number
 * is invisible without BOTH a recipe model and a stock ledger, which is precisely why it's worth
 * computing — and why it must never be estimated when either input is unknown.
 */
export const computeCostVariance = (
  cogsActual: UnknownOr<Money>,
  cogsTheoretical: UnknownOr<Money>
): CostVarianceResult => {
  if (cogsActual === 'unknown' || cogsTheoretical === 'unknown') {
    return { variance: 'unknown', direction: 'unknown' };
  }
  const variance = subtractMoney(cogsActual, cogsTheoretical);
  const comparison = compareMoney(variance, zeroMoney(variance.currency));
  return {
    variance,
    direction: comparison > 0 ? 'over' : comparison < 0 ? 'under' : 'exact',
  };
};

/**
 * `contribution_margin` = `net_revenue − cogs_actual`. Deliberately NOT called "profit": rent,
 * labour, utilities, and tax are outside this system's data boundary, and implying otherwise would
 * misrepresent a partial figure as a complete one.
 */
export const computeContributionMargin = (
  netRevenue: Money,
  cogsActual: UnknownOr<Money>
): UnknownOr<Money> => {
  if (cogsActual === 'unknown') return 'unknown';
  return subtractMoney(netRevenue, cogsActual);
};

/**
 * `food_cost_percentage` = `cogs / net_revenue`, the industry's headline number. Returns
 * `'unknown'` when COGS is unknown, and — critically — also when revenue is zero: dividing by zero
 * is undefined, and a period with no sales has no meaningful food-cost ratio. Returning 0% there
 * would read as "outstanding cost control" when it actually means "we sold nothing."
 */
export const computeFoodCostPercentage = (
  cogs: UnknownOr<Money>,
  netRevenue: Money
): UnknownOr<number> => {
  if (cogs === 'unknown') return 'unknown';
  if (netRevenue.amount.isZero()) return 'unknown';
  return cogs.amount.dividedBy(netRevenue.amount).times(100).toDecimalPlaces(2).toNumber();
};

/**
 * `contribution_margin_percentage` = `contribution_margin / net_revenue`. Same zero-revenue guard
 * and same reasoning as food cost percentage.
 */
export const computeContributionMarginPercentage = (
  contributionMargin: UnknownOr<Money>,
  netRevenue: Money
): UnknownOr<number> => {
  if (contributionMargin === 'unknown') return 'unknown';
  if (netRevenue.amount.isZero()) return 'unknown';
  return contributionMargin.amount
    .dividedBy(netRevenue.amount)
    .times(100)
    .toDecimalPlaces(2)
    .toNumber();
};

/* ------------------------------------------------------------------ waste */

export type WasteLine = {
  reasonCode: string;
  /** `'unknown'` when the wasted lot had no known cost. */
  value: Money | 'unknown';
};

export type WasteBreakdown = {
  total: UnknownOr<Money>;
  /** Sorted by value descending — the biggest loss first, since that's the actionable one. */
  byReason: Array<{ reasonCode: string; value: Money }>;
  /**
   * How many waste events had no known cost. Surfaced rather than hidden: a total of "unknown"
   * with no explanation is unhelpful, but "unknown, because 3 of 14 events had no lot cost" tells
   * the user exactly what to fix.
   */
  unknownCostEventCount: number;
};

/**
 * `waste_value` plus its reason-code breakdown. Reason codes are a fixed, database-enforced set on
 * WASTE movements, which is what makes this groupable at all — free-text reasons would produce a
 * long tail of near-duplicates that can't be summed meaningfully.
 */
export const computeWasteBreakdown = (
  lines: WasteLine[],
  currency: Money['currency']
): WasteBreakdown => {
  const unknownCostEventCount = lines.filter((line) => line.value === 'unknown').length;

  const byReasonMap = new Map<string, Money>();
  for (const line of lines) {
    if (line.value === 'unknown') continue;
    const existing = byReasonMap.get(line.reasonCode);
    byReasonMap.set(line.reasonCode, existing ? addMoney(existing, line.value) : line.value);
  }

  const byReason = [...byReasonMap.entries()]
    .map(([reasonCode, value]) => ({ reasonCode, value }))
    .sort((a, b) => compareMoney(b.value, a.value));

  // If any event's cost is unknown, the TOTAL is unknown — same all-or-nothing rule as COGS. The
  // per-reason breakdown still shows what IS known, so the user isn't left with nothing.
  const total: UnknownOr<Money> =
    unknownCostEventCount > 0
      ? 'unknown'
      : byReason.reduce((sum, entry) => addMoney(sum, entry.value), zeroMoney(currency));

  return { total, byReason, unknownCostEventCount };
};
