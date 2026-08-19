import { addMoney, compareMoney, money, zeroMoney, type Money } from '@retailos/domain';
import Decimal from 'decimal.js';
import type { UnknownOr } from '../margin/margin.js';

/**
 * Inventory metrics — the design, all 9. Every function here is pure: given already-fetched rows,
 * it computes one number. No database access, matching every other file in this package.
 *
 * Two deliberate, confirmed deviations from the spec's literal grain (both narrower scope, not
 * formula changes — see `catalog-entries.ts` for where each is wired):
 *  - `negative_stock_incidents`: registered as a live snapshot COUNT ("currently negative"), not a
 *    store/period historical tally — `findNegativeStock` is structurally a point-in-time
 *    sweep, and this project's own standing framing ("negative stock is a signal, not an error")
 *    treats it as a real-time signal, not a thing to count historically.
 *  - `stockout_events`/`stockout_revenue_impact` DO honor the spec's literal store/period grain —
 *    unlike negative_stock_incidents, a real running-balance reconstruction was built for these
 *    (`StockLevelRepository.findStockoutDays`) since the COUNT of stockout days is the entire point
 *    of the metric.
 */

/* ------------------------------------------------------------------ stock_on_hand / stock_value */

export type StockValueLine = { categoryId: string | null; totalValue: string };

export type StockValueByCategory = { categoryId: string | null; value: Money };

/**
 * `stock_value` = `Σ remaining_qty × lot_cost`, grouped by category. A `categoryId: null` group
 * (an uncategorized product) is a real, included row, never dropped — its real value still counts
 * toward the store's total cash tied up (I7: silently excluding it would understate the metric).
 */
export const computeStockValueByCategory = (
  lines: StockValueLine[],
  currency: Money['currency']
): StockValueByCategory[] =>
  lines
    .map((line) => ({ categoryId: line.categoryId, value: money(line.totalValue, currency) }))
    .sort((a, b) => compareMoney(b.value, a.value));

/** The store-wide total across every category — a real zero when there is no stock at all, never `'unknown'`. */
export const computeTotalStockValue = (
  byCategory: StockValueByCategory[],
  currency: Money['currency']
): Money => byCategory.reduce((sum, entry) => addMoney(sum, entry.value), zeroMoney(currency));

/* ------------------------------------------------------------------ days_of_supply */

/**
 * `days_of_supply` = `stock_on_hand / avg_daily_consumption`. `'unknown'` when there is no
 * consumption history at all (division by zero is undefined, and I7 forbids reading "no history"
 * as "infinite supply" or "zero days") — matching `findExpiryQueue`'s own established treatment of
 * this exact division.
 */
export const computeDaysOfSupply = (
  stockOnHand: string,
  avgDailyConsumption: string | null
): UnknownOr<string> => {
  if (avgDailyConsumption === null) return 'unknown';
  const daily = new Decimal(avgDailyConsumption);
  if (daily.lessThanOrEqualTo(0)) return 'unknown';
  return new Decimal(stockOnHand).dividedBy(daily).toFixed(2);
};

/* ------------------------------------------------------------------ inventory_turnover */

/**
 * `inventory_turnover` = `cogs_period / avg_stock_value`, annualized for comparison
 * (`× 365 / periodDays`, the standard annualization for a period shorter than a year). `'unknown'`
 * when average stock value is zero — a store holding no stock has no meaningful turnover ratio to
 * report (dividing by zero, or claiming "infinite turnover," would both be fabrications).
 */
export const computeInventoryTurnover = (
  cogsPeriod: Money | 'unknown',
  avgStockValue: Money,
  periodDays: number
): UnknownOr<number> => {
  if (cogsPeriod === 'unknown') return 'unknown';
  if (avgStockValue.amount.lessThanOrEqualTo(0)) return 'unknown';
  const raw = cogsPeriod.amount.dividedBy(avgStockValue.amount);
  const annualized = raw.times(365).dividedBy(periodDays);
  return annualized.toDecimalPlaces(2).toNumber();
};

/* ------------------------------------------------------------------ dead_stock_value */

export type DeadStockLine = {
  quantity: string;
  /** `'unknown'` when no average cost has ever been recorded for this product/variant. */
  avgUnitCost: Money | 'unknown';
};

export type DeadStockResult = {
  total: UnknownOr<Money>;
  /** How many dead-stock lines had no known cost — surfaced, not hidden, when total is unknown. */
  unknownCostLineCount: number;
};

/**
 * `dead_stock_value` = value of items with zero movement in N days. Same all-or-nothing rule as
 * every other costed total in this catalog: one line with an unknown average cost makes the WHOLE
 * total unknown, never a partial sum that understates the real dead-stock value.
 */
export const computeDeadStockValue = (
  lines: DeadStockLine[],
  currency: Money['currency']
): DeadStockResult => {
  const unknownCostLineCount = lines.filter((line) => line.avgUnitCost === 'unknown').length;
  if (unknownCostLineCount > 0) {
    return { total: 'unknown', unknownCostLineCount };
  }
  const total = lines.reduce((sum, line) => {
    const cost = line.avgUnitCost as Money;
    const lineValue = cost.amount.times(new Decimal(line.quantity));
    return addMoney(sum, money(lineValue, cost.currency));
  }, zeroMoney(currency));
  return { total, unknownCostLineCount: 0 };
};

/* ------------------------------------------------------------------ expiry_risk_value */

export type ExpiryRiskLine = { valueAtRisk: string; daysToExpiry: number };

/**
 * `expiry_risk_value` = `Σ(qty expiring in N days × cost)` WHERE cover exceeds days remaining —
 * a bounded-horizon aggregation over `findExpiryQueue`'s own already-computed `valueAtRisk`
 * (which already encodes the "cover exceeds days remaining" filter at the row level, per
 * `findExpiryQueue`'s own WHERE clause). This function's only job is summing the rows within the
 * caller's chosen `N`-day horizon — the risk determination itself already happened upstream.
 */
export const computeExpiryRiskValue = (
  lines: ExpiryRiskLine[],
  horizonDays: number,
  currency: Money['currency']
): Money =>
  lines
    .filter((line) => line.daysToExpiry <= horizonDays)
    .reduce((sum, line) => addMoney(sum, money(line.valueAtRisk, currency)), zeroMoney(currency));

/* ------------------------------------------------------------------ stockout_events / stockout_revenue_impact */

export type StockoutDay = { productId: string; variantId: string; stockoutDate: string };

/** `stockout_events` = count of (product, day) at zero WITH prior demand — a plain count of the rows `findStockoutDays` already filtered correctly. */
export const computeStockoutEventCount = (days: StockoutDay[]): number => days.length;

export type StockoutRevenueImpactInput = {
  stockoutDayCount: number;
  /** `'unknown'` when no consumption history exists for this product to estimate lost sales from. */
  avgDailyConsumption: string | null;
  /** The product's real average realized selling price — `'unknown'` if it was never sold. */
  avgUnitPrice: Money | 'unknown';
};

export type StockoutRevenueImpactResult = {
  /** `'unknown'` when either input needed for the estimate is unknown. Always labeled an estimate by the caller — this is the design's own ONE disclosed-estimate metric. */
  estimatedImpact: UnknownOr<Money>;
};

/**
 * `stockout_revenue_impact` — the design's ONE deliberate estimate in the whole catalog, "using
 * trailing average velocity." `estimated lost revenue = stockout_days × avg_daily_consumption ×
 * avg_unit_price` — the plain, disclosed method the spec calls for, not a fabricated composite.
 * `'unknown'` (never a guessed number) when either the consumption rate or the selling price is
 * itself unknown.
 */
export const computeStockoutRevenueImpact = (
  input: StockoutRevenueImpactInput,
  currency: Money['currency']
): StockoutRevenueImpactResult => {
  if (input.avgDailyConsumption === null || input.avgUnitPrice === 'unknown') {
    return { estimatedImpact: 'unknown' };
  }
  const lostUnits = new Decimal(input.avgDailyConsumption).times(input.stockoutDayCount);
  const estimatedImpact = money(lostUnits.times(input.avgUnitPrice.amount), currency);
  return { estimatedImpact };
};

/* ------------------------------------------------------------------ negative_stock_incidents */

/** `negative_stock_incidents` — registered as a live snapshot count (see this file's own header for the confirmed scope deviation). A plain count of the rows `findNegativeStock` already returns. */
export const computeNegativeStockIncidentCount = (rows: unknown[]): number => rows.length;

/* ------------------------------------------------------------------ stock_projection_drift */

/**
 * `stock_projection_drift` — registered as a COUNT of
 * drifted product/variant rows, not a summed `|projection − ledger sum|` magnitude: the underlying
 * quantities are in each product's own base unit (I6), so adding an apple's drift to a liter of
 * milk's drift would produce a meaningless mixed-unit number. A count of "how many rows disagree"
 * is the honest, unit-safe reading of "is the bug detector finding anything right now" — the same
 * live-snapshot-count framing `negative_stock_incidents` above already established for a real-time
 * data-quality signal. Any row `StockLevelRepository.findDriftForOrg` returns is, by construction,
 * already a genuine drift (its own `HAVING` clause only returns disagreeing rows) — this function
 * doesn't recompute the comparison, only counts.
 */
export const computeStockProjectionDriftCount = (rows: unknown[]): number => rows.length;
