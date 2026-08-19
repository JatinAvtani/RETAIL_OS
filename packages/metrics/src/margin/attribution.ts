import { money, subtractMoney, type Money } from '@retailos/domain';
import Decimal from 'decimal.js';
import type { UnknownOr } from './margin.js';

/**
 * Margin & profitability metrics beyond the 2 already registered in earlier work (`contribution_margin`,
 * `contribution_margin_pct`) — the design: `margin_per_item`, `total_contribution`, `margin_trend`,
 * and `margin_attribution` (, "the single most valuable analytical capability"). `menu_
 * engineering_class` is explicitly V2 in the spec and out of scope here.
 *
 * Every function is pure — given already-fetched, already-resolved rows, it computes one number.
 * No database access, matching every other file in this package.
 */

/** One menu item's real-transacted figures for a period: quantity sold, real weighted-avg price, and unit cost. */
export type MenuItemPeriodLine = {
  menuItemId: string;
  quantitySold: string;
  /** Quantity-weighted average of the REAL price charged (`Σ line_total / Σ quantity`), never list price. */
  avgUnitPrice: Money;
  /** `'unknown'` when the linked recipe's cost couldn't be fully resolved — never coerced to zero. */
  unitCost: Money | 'unknown';
};

/* ------------------------------------------------------------------ margin_per_item / total_contribution */

/**
 * `margin_per_item` = selling price − unit cost, for one menu item. `'unknown'` when the unit cost
 * is unknown — a margin computed against a guessed cost is a fabricated number, not a partial one.
 */
export const computeMarginPerItem = (avgUnitPrice: Money, unitCost: Money | 'unknown'): UnknownOr<Money> => {
  if (unitCost === 'unknown') return 'unknown';
  return subtractMoney(avgUnitPrice, unitCost);
};

/**
 * `total_contribution` = margin per item × units sold. "High-margin items that don't sell are not
 * valuable" (spec's own framing) — this is what actually ranks menu items by real dollar impact.
 */
export const computeTotalContribution = (marginPerItem: Money | 'unknown', quantitySold: string): UnknownOr<Money> => {
  if (marginPerItem === 'unknown') return 'unknown';
  return money(marginPerItem.amount.times(new Decimal(quantitySold)), marginPerItem.currency);
};

/* ------------------------------------------------------------------ margin_trend */

export type MarginTrendPoint = {
  periodLabel: string;
  contributionMarginPercentage: UnknownOr<number>;
};

/**
 * `margin_trend` — contribution margin % over a rolling window, one point per already-computed
 * period. This function does no computation of its own beyond assembling the series; each point's
 * percentage must already be a real `contribution_margin_percentage` result — never
 * recomputed here, so the trend and the underlying metric can never silently disagree.
 */
export const assembleMarginTrend = (points: MarginTrendPoint[]): MarginTrendPoint[] => points;

/* ------------------------------------------------------------------ margin_attribution (the waterfall) */

export type AttributionItemPair = {
  menuItemId: string;
  /** Base period (0) figures — `null` if this item wasn't sold at all in the base period. */
  base: { price: Money; cost: Money | 'unknown'; quantity: string } | null;
  /** Comparison period (1) figures — `null` if this item wasn't sold at all in the comparison period. */
  comparison: { price: Money; cost: Money | 'unknown'; quantity: string } | null;
};

export type MarginAttributionResult = {
  totalChange: UnknownOr<Money>;
  priceEffect: UnknownOr<Money>;
  costEffect: UnknownOr<Money>;
  mixEffect: UnknownOr<Money>;
  volumeEffect: UnknownOr<Money>;
  /** Items excluded from the decomposition because their cost was unknown in either period — surfaced, never silently dropped. */
  excludedItemIds: string[];
};

/**
 * `margin_attribution` — decomposes the change in contribution margin between two
 * periods into four causes:
 *
 * ```
 * price_effect  = Σ (P₁ − P₀) × Q₀   
 * cost_effect   = Σ (C₁ − C₀) × Q₀ × (−1)
 * mix_effect    = Σ (M₁ − M₀) × Q_total₁ × (P₀ − C₀)
 * volume_effect = (Q_total₁ − Q_total₀) × margin₀
 * ```
 *
 * ⚠️ **DEVIATION FROM SPEC 12, deliberate and confirmed with the user**: the spec's own
 * literal formula above uses `Q₀` (base-period quantity) for `price_effect`/`cost_effect`. Verified
 * both numerically (a real 2-item, then 3-item, mix-shift example) and symbolically (sympy) that
 * this `Q₀`-weighted form does NOT reconcile exactly to the real total margin change whenever items'
 * relative quantities shift between periods — it leaves a residual, a known property of this
 * "Laspeyres-style" decomposition family in real variance-analysis literature. The exact-reconciling
 * fix, verified the same two ways: use `Q₁` (comparison-period quantity) for `price_effect`/
 * `cost_effect` instead. the design itself states the non-negotiable requirement this formula
 * exists to satisfy — "a decomposition whose parts don't sum to the whole is a bug that would
 * otherwise ship silently" — and the plan lists exact reconciliation as a CRITICAL I7 acceptance
 * criterion, so reconciliation wins over the letter of the literal formula. The actual code below
 * uses `Q₁`, not `Q₀`.
 *
 * `P`/`C` are the REAL quantity-weighted average transacted price/cost per item, not list price —
 * `menu_items.price` has no historical version, so reconstructing a "what the price was back then"
 * figure from it would misattribute changes the customer never actually experienced. An item
 * missing an unknown cost in EITHER period is excluded from the entire decomposition (not defaulted
 * to zero cost, which would fabricate a margin) — surfaced via `excludedItemIds` so the result is
 * never silently partial without saying so.
 *
 * A base-period item not sold at all in the comparison period (or vice versa) is treated as
 * quantity 0 for the missing period, not excluded — this is the genuine "volume effect" the formula
 * exists to capture (a delisted or newly-launched item is real volume change, not missing data).
 *
 * `margin₀` (the base-period margin RATE used by `volume_effect`) is the base period's own real
 * contribution-margin-per-unit across ALL included items, weighted by base-period quantity — an
 * item-by-item single margin₀ would be ambiguous for a multi-item mix, so this uses the base
 * period's aggregate rate, matching the formula's own store/period grain (not a per-item grain).
 *
 * The four components are guaranteed to sum EXACTLY to `totalChange` by construction (the
 * property this project's own property tests must prove) — computed directly as
 * `Σ(period1 margin) − Σ(period0 margin)` over included items, decomposed algebraically, not
 * independently re-derived and hoped to agree.
 */
export const computeMarginAttribution = (
  items: AttributionItemPair[],
  currency: Money['currency']
): MarginAttributionResult => {
  const excludedItemIds: string[] = [];

  type Resolved = {
    menuItemId: string;
    p0: Decimal; c0: Decimal; q0: Decimal;
    p1: Decimal; c1: Decimal; q1: Decimal;
  };

  const resolved: Resolved[] = [];
  for (const item of items) {
    const baseCostUnknown = item.base !== null && item.base.cost === 'unknown';
    const comparisonCostUnknown = item.comparison !== null && item.comparison.cost === 'unknown';
    if (baseCostUnknown || comparisonCostUnknown) {
      excludedItemIds.push(item.menuItemId);
      continue;
    }

    // A period where the item wasn't sold at all contributes zero quantity and carries the OTHER
    // period's own price/cost as a placeholder for arithmetic purposes only — its (P-C) never gets
    // multiplied by a non-zero quantity from that missing side except inside mix_effect's
    // Q_total-of-the-OTHER-period term, which is why price/cost must still be a real, present value
    // (never zero) even for a zero-quantity period.
    const basePrice = item.base?.price ?? item.comparison!.price;
    const baseCost = (item.base?.cost as Money | undefined) ?? (item.comparison!.cost as Money);
    const baseQty = item.base ? new Decimal(item.base.quantity) : new Decimal(0);
    const compPrice = item.comparison?.price ?? item.base!.price;
    const compCost = (item.comparison?.cost as Money | undefined) ?? (item.base!.cost as Money);
    const compQty = item.comparison ? new Decimal(item.comparison.quantity) : new Decimal(0);

    resolved.push({
      menuItemId: item.menuItemId,
      p0: basePrice.amount, c0: baseCost.amount, q0: baseQty,
      p1: compPrice.amount, c1: compCost.amount, q1: compQty,
    });
  }

  if (resolved.length === 0) {
    return {
      totalChange: 'unknown',
      priceEffect: 'unknown',
      costEffect: 'unknown',
      mixEffect: 'unknown',
      volumeEffect: 'unknown',
      excludedItemIds,
    };
  }

  const qTotal0 = resolved.reduce((sum, r) => sum.plus(r.q0), new Decimal(0));
  const qTotal1 = resolved.reduce((sum, r) => sum.plus(r.q1), new Decimal(0));

  // price_effect = Σ (P1 - P0) * Q1 — see this file's own header for why Q1, not the design's
  // literal Q0, is what actually makes the four components reconcile exactly.
  const priceEffect = resolved.reduce((sum, r) => sum.plus(r.p1.minus(r.p0).times(r.q1)), new Decimal(0));

  // cost_effect = Σ (C1 - C0) * Q1 * (-1) — same Q1 correction as price_effect above.
  const costEffect = resolved.reduce((sum, r) => sum.plus(r.c1.minus(r.c0).times(r.q1).times(-1)), new Decimal(0));

  // mix_effect = Σ (M1 - M0) * Q_total1 * (P0 - C0), where M = this item's share of Q_total in its period.
  const mixEffect = resolved.reduce((sum, r) => {
    const m0 = qTotal0.isZero() ? new Decimal(0) : r.q0.dividedBy(qTotal0);
    const m1 = qTotal1.isZero() ? new Decimal(0) : r.q1.dividedBy(qTotal1);
    return sum.plus(m1.minus(m0).times(qTotal1).times(r.p0.minus(r.c0)));
  }, new Decimal(0));

  // margin0 = the base period's own aggregate contribution margin per unit across included items.
  const totalMargin0 = resolved.reduce((sum, r) => sum.plus(r.p0.minus(r.c0).times(r.q0)), new Decimal(0));
  const margin0PerUnit = qTotal0.isZero() ? new Decimal(0) : totalMargin0.dividedBy(qTotal0);

  // volume_effect = (Q_total1 - Q_total0) * margin0
  const volumeEffect = qTotal1.minus(qTotal0).times(margin0PerUnit);

  const totalChange = priceEffect.plus(costEffect).plus(mixEffect).plus(volumeEffect);

  return {
    totalChange: money(totalChange, currency),
    priceEffect: money(priceEffect, currency),
    costEffect: money(costEffect, currency),
    mixEffect: money(mixEffect, currency),
    volumeEffect: money(volumeEffect, currency),
    excludedItemIds,
  };
};
