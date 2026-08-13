import { Decimal } from 'decimal.js';

/**
 * 008-14 (spec 05 §5.3.4, plan.md Phase 5): "nightly diff of invoice unit prices against trailing
 * baseline: IF |new_price − baseline| / baseline > threshold: emit supplier.price_changed."
 * `PostingService.postLineInTx` already closes the old `supplier_prices` row and opens a new one on
 * EVERY posted line — that pre-existing code unconditionally emitted `supplier.price_changed` on
 * every single post, never actually checking the threshold spec names. This function is the real
 * gate that was missing: given the price transition PostingService already resolved, decide whether
 * it's a real, actionable change, and — if so — the annualized dollar impact that makes an owner
 * act on it (`annualized_impact = Δunit_price × trailing_12mo_quantity`, spec's own literal formula).
 *
 * A pure function (I1 — no I/O). The caller resolves `oldUnitPrice`/`newUnitPrice` (from
 * `supplier_prices`) and `trailing12moQuantity` (a real `stock_movements` RECEIPT sum, confirmed
 * with the user over `purchase_order_lines`, since the ledger reflects actual purchasing volume
 * including walk-in/no-PO receipts, not just what was ordered).
 */

export interface PriceChangeInput {
  oldUnitPrice: Decimal;
  newUnitPrice: Decimal;
  /** Real trailing-365-day RECEIPT quantity for this product, in base units. `null` means no receiving history exists yet — the function then reports the percent change but leaves the dollar impact `'unknown'` rather than guessing a volume (I7). */
  trailing12moQuantity: Decimal | null;
}

/** Spec names no specific number — 2% mirrors `DEFAULT_MATCH_TOLERANCES.priceTolerancePercent` (008-10/11's own real default for "is this variance worth a human's attention"), the same bar this codebase already applies to a price gap on an invoice. */
export const DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT = new Decimal('0.02');

export interface PriceChangeResult {
  /** `false` when the old price was zero (an undefined percent change) or the delta is within threshold — no real change worth surfacing. */
  isSignificantChange: boolean;
  percentChange: Decimal | null;
  priceDelta: Decimal;
  /** `Δunit_price × trailing_12mo_quantity` — `'unknown'` when no trailing quantity exists (I7), never a guessed dollar figure. */
  annualizedImpact: Decimal | 'unknown';
}

export const detectPriceChange = (
  input: PriceChangeInput,
  thresholdPercent: Decimal = DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT
): PriceChangeResult => {
  const priceDelta = input.newUnitPrice.minus(input.oldUnitPrice);
  const percentChange = input.oldUnitPrice.isZero() ? null : priceDelta.abs().dividedBy(input.oldUnitPrice);

  const isSignificantChange = percentChange !== null && percentChange.greaterThan(thresholdPercent);

  const annualizedImpact: Decimal | 'unknown' =
    input.trailing12moQuantity !== null ? priceDelta.times(input.trailing12moQuantity) : 'unknown';

  return { isSignificantChange, percentChange, priceDelta, annualizedImpact };
};
