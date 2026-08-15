import { addMoney, compareMoney, money, zeroMoney, type Money } from '@retailos/domain';
import Decimal from 'decimal.js';
import type { UnknownOr } from '../margin/margin.js';

/**
 * Purchasing metrics — spec 12 §F, all 8. Every function here is pure: given already-fetched rows,
 * it computes one number. No database access, matching every other file in this package.
 *
 * `total_spend`/`spend_by_category` are scoped to purchase order lines whose parent PO's status is
 * `APPROVED` or later (`APPROVED`, `SENT`, `PARTIALLY_RECEIVED`, `RECEIVED`, `CLOSED`) — confirmed
 * with the user, since this codebase has no invoice-level "approved" concept at all (spec 12 §F's
 * literal "approved invoice totals" wording has no real schema referent — `invoice_matches.status`
 * is a review-workflow state, PENDING/REVIEWED/RESOLVED, not an approval/payment gate). PO-level
 * approval is the real, existing "someone signed off on this spend" fact in the schema.
 *
 * `price_variance_total` is a genuinely NEW, quantity-weighted function reading from
 * `invoice_match_lines` — deliberately distinct from `supplier-performance.ts`'s
 * `computeTotalPriceVariance`, which sums UNWEIGHTED per-unit variance from
 * `supplier_performance_events` (that file's own doc comment states this was a confirmed, narrower
 * scope decision, not this metric). Both compute a real number; they answer different questions.
 */

/* ------------------------------------------------------------------ total_spend / spend_by_category */

export type ApprovedSpendLine = {
  categoryId: string | null;
  lineTotal: string;
};

export type SpendByCategory = { categoryId: string | null; value: Money };

/**
 * `spend_by_category` = approved PO line totals grouped by product category. A `categoryId: null`
 * group (an uncategorized product) is a real, included row, never dropped (I7) — its spend still
 * counts toward the store's real total.
 */
export const computeSpendByCategory = (
  lines: ApprovedSpendLine[],
  currency: Money['currency']
): SpendByCategory[] => {
  const byCategory = new Map<string | null, Money>();
  for (const line of lines) {
    const existing = byCategory.get(line.categoryId);
    const value = money(line.lineTotal, currency);
    byCategory.set(line.categoryId, existing ? addMoney(existing, value) : value);
  }
  return [...byCategory.entries()]
    .map(([categoryId, value]) => ({ categoryId, value }))
    .sort((a, b) => compareMoney(b.value, a.value));
};

/** `total_spend` — the store-wide total across every category. A real zero when nothing is approved yet, never `'unknown'`. */
export const computeTotalSpend = (byCategory: SpendByCategory[], currency: Money['currency']): Money =>
  byCategory.reduce((sum, entry) => addMoney(sum, entry.value), zeroMoney(currency));

/* ------------------------------------------------------------------ price_variance_total */

export type PriceVarianceLine = {
  /** Already `invoiceUnitPrice - poUnitPrice`, per unit (packages/domain's classifyLineMatch). */
  priceVariance: string;
  /** The billed quantity — this metric weights by what was actually invoiced, not received. */
  invoiceQuantity: string;
};

/**
 * `price_variance_total` = `Σ(invoice_price − po_price) × qty` (spec 12 §F's literal formula) —
 * `priceVariance` is already the per-unit `(invoice_price − po_price)` difference, so this function
 * multiplies each line by its invoice quantity and sums. Only lines where BOTH `priceVariance` and
 * `invoiceQuantity` are present are included — `classifyLineMatch` populates these independently
 * (one governed by whether a PO price was found, the other by whether the invoice line itself
 * parsed), so neither field's presence can be inferred from the other.
 */
export const computePriceVarianceTotal = (
  lines: PriceVarianceLine[],
  currency: Money['currency']
): Money =>
  lines.reduce((sum, line) => {
    const lineVariance = new Decimal(line.priceVariance).times(line.invoiceQuantity);
    return addMoney(sum, money(lineVariance, currency));
  }, zeroMoney(currency));

/* ------------------------------------------------------------------ price_change_impact */

/**
 * `price_change_impact` = `Δunit_price × trailing_12mo_qty` (spec 12 §F). This is NOT recomputed
 * here — `packages/domain`'s `detectPriceChange` (008-14) already implements this exact formula
 * and `PostingService` already persists its result as a `supplier_performance_events` row's
 * `variance` field on every real, threshold-crossing `PRICE_CHANGE` event (see that schema file's
 * own doc comment). This function's only job is picking the most recent such event and reading its
 * already-computed variance — a second, independent implementation of the same formula would risk
 * silently drifting from the one `PostingService` actually uses to detect and gate the event in
 * the first place (I2: one place computes a business number).
 */
export type PriceChangeEvent = {
  variance: string | null;
  occurredAt: Date;
};

export const computePriceChangeImpact = (
  events: PriceChangeEvent[],
  currency: Money['currency']
): UnknownOr<Money> => {
  const mostRecent = events.reduce<PriceChangeEvent | null>(
    (latest, event) => (latest === null || event.occurredAt > latest.occurredAt ? event : latest),
    null
  );
  if (mostRecent === null || mostRecent.variance === null) return 'unknown';
  return money(mostRecent.variance, currency);
};

/* ------------------------------------------------------------------ po_cycle_time */

export type PoCycleTimeLine = {
  createdAt: Date;
  sentAt: Date;
};

/**
 * `po_cycle_time` — spec 12 §F's literal wording is "avg hours: created → sent," but the metric
 * catalog's `MetricUnit` type has no `HOURS` option (only `CURRENCY | PERCENTAGE | COUNT | RATIO |
 * DAYS`) — confirmed with the user: compute in DAYS instead (dividing by 24), registered as
 * `unit: 'DAYS'`, rather than mislabeling an hours-value as days or widening a shared catalog type
 * for one metric. Only POs that have actually been sent are included — a PO still sitting in
 * DRAFT/PENDING_APPROVAL has no real cycle time yet, and including it as "still counting" would
 * understate the true average for POs that eventually complete the step. `'unknown'` with zero
 * sent POs in the period (I7 — never a fabricated 0-day average).
 */
export const computePoCycleTime = (lines: PoCycleTimeLine[]): UnknownOr<number> => {
  if (lines.length === 0) return 'unknown';
  const totalDays = lines.reduce((sum, line) => {
    const days = (line.sentAt.getTime() - line.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    return sum + days;
  }, 0);
  return new Decimal(totalDays).dividedBy(lines.length).toDecimalPlaces(2).toNumber();
};

/* ------------------------------------------------------------------ order_frequency / average_order_value */

/** `order_frequency` — a plain count of POs created for one supplier in the period. A real zero when none were placed. */
export const computeOrderFrequency = (poCount: number): number => poCount;

/**
 * `average_order_value` = `spend / PO count`. `'unknown'` with zero POs (I7 — never a fabricated
 * $0 average or a division by zero).
 */
export const computeAverageOrderValue = (
  totalSpend: Money,
  poCount: number,
  currency: Money['currency']
): UnknownOr<Money> => {
  if (poCount === 0) return 'unknown';
  return money(totalSpend.amount.dividedBy(poCount), currency);
};

/* ------------------------------------------------------------------ emergency_purchase_rate */

/**
 * `emergency_purchase_rate` = receipts with no linked PO ÷ all receipts (`goods_receipts.
 * purchaseOrderId IS NULL` is the real, schema-native signal for a walk-in/emergency purchase —
 * 008-09's own scope). `'unknown'` with zero receipts in the period (I7 — never a fabricated 0%,
 * since "no receipts at all" says nothing about planning quality, the thing this rate measures).
 */
export const computeEmergencyPurchaseRate = (
  receiptsWithoutPoCount: number,
  totalReceiptCount: number
): UnknownOr<number> => {
  if (totalReceiptCount === 0) return 'unknown';
  return new Decimal(receiptsWithoutPoCount)
    .dividedBy(totalReceiptCount)
    .times(100)
    .toDecimalPlaces(2)
    .toNumber();
};
