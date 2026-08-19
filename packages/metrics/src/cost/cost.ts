import { money, type CurrencyCode, type Money } from '@retailos/domain';
import type { UnknownOr } from '../margin/margin.js';

/**
 * Cost metrics — the design. Four of the section's 8 metrics (`cogs_actual`, `cogs_theoretical`,
 * `food_cost_percentage`, `cost_variance`) are already registered via `margin/catalog-entries.ts`
 * — this file covers the remaining 4: `unit_cost_weighted_avg`, `unit_cost_latest`,
 * `recipe_cost`, `menu_item_cost`.
 *
 * `unit_cost_weighted_avg`/`unit_cost_latest` are thin — the real work (maintaining a weighted
 * average as stock moves, finding the currently-effective price) already happens in
 * `MovementService`/`SupplierPriceRepository`. These functions exist so a single lookup value still
 * goes through the catalog's `'unknown'`-not-fabricated convention (I7) rather than a route handler
 * defaulting a missing average cost to zero, which would silently claim a product with no recorded
 * stock movement costs nothing at all.
 */

/**
 * `unit_cost_weighted_avg` — the weighted average cost of on-hand stock for one product+variant+
 * store. `null` (no stock movement has ever set this row's average) is `'unknown'`, never `0` —
 * a product that has literally never been received has no cost to report, which is a different
 * fact from "costs nothing."
 */
export const resolveUnitCostWeightedAvg = (
  avgUnitCost: string | null,
  currency: CurrencyCode
): UnknownOr<Money> => {
  if (avgUnitCost === null) return 'unknown';
  return money(avgUnitCost, currency);
};

/**
 * `unit_cost_latest` — the currently-effective invoice unit price for one confirmed
 * supplier-product mapping. `null` (no currently-effective price row) is `'unknown'`.
 */
export const resolveUnitCostLatest = (currentPrice: { unitPrice: string; currency: CurrencyCode } | null): UnknownOr<Money> => {
  if (currentPrice === null) return 'unknown';
  return money(currentPrice.unitPrice, currentPrice.currency);
};
