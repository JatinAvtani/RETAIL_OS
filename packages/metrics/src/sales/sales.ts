import { addMoney, compareMoney, money, resolveLocalDaypart, zeroMoney, type Daypart, type Money } from '@retailos/domain';
import Decimal from 'decimal.js';
import type { UnknownOr } from '../margin/margin.js';

/**
 * Sales metrics — the design, the 9 metrics grounding every downstream cost/margin figure. Every
 * function here is pure: given already-fetched rows (and, where a period boundary or daypart is
 * involved, the store's own timezone), it computes one number. No database access — that happens
 * at the boundary before these are called, matching `margin.ts`'s own precedent exactly.
 *
 * `discount_rate`/`refund_rate` divide by `gross_revenue`, so both return `'unknown'` (never a
 * fabricated 0%) when gross revenue is zero — a period with no sales has no meaningful rate, and
 * 0% would misleadingly read as "no discounting/refunds happened" rather than "nothing was sold."
 */

/** One transaction header, regardless of status — the input to gross/discount/refund metrics. */
export type TransactionHeader = {
  occurredAt: Date;
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
  status: 'COMPLETED' | 'REFUNDED' | 'VOIDED';
};

/* ------------------------------------------------------------------ revenue */

/**
 * `gross_revenue` = `Σ line_total` before discounts — here, `Σ subtotal` over completed
 * transactions, since `subtotal` is the vendor's own pre-discount figure (never recomputed from
 * lines — see `sales_transactions`' own schema comment on why).
 */
export const computeGrossRevenue = (transactions: TransactionHeader[], currency: Money['currency']): Money =>
  transactions
    .filter((t) => t.status === 'COMPLETED')
    .reduce((sum, t) => addMoney(sum, t.subtotal), zeroMoney(currency));

/** `transaction_count` — completed transactions only ("covers" in restaurant language). */
export const computeTransactionCount = (transactions: TransactionHeader[]): number =>
  transactions.filter((t) => t.status === 'COMPLETED').length;

/**
 * `average_transaction_value` = `net_revenue / transaction_count`. Returns `'unknown'` for zero
 * transactions — division by zero is undefined, and "no sales" has no meaningful average, not a
 * $0.00 one.
 */
export const computeAverageTransactionValue = (
  netRevenue: Money,
  transactionCount: number
): UnknownOr<Money> => {
  if (transactionCount === 0) return 'unknown';
  return money(netRevenue.amount.dividedBy(transactionCount), netRevenue.currency);
};

/** `units_sold` = `Σ quantity` across completed sales lines in the period. */
export const computeUnitsSold = (quantities: string[]): string =>
  quantities.reduce((sum, q) => sum.plus(new Decimal(q)), new Decimal(0)).toFixed(6);

/* ------------------------------------------------------------------ rates */

export type DiscountRateResult = { rate: UnknownOr<number>; totalDiscount: Money };

/**
 * `discount_rate` = `discounts / gross_revenue`. Unknown at zero gross revenue (see module header)
 * — never a fabricated 0%, which would read as "no discounting" rather than "nothing sold."
 */
export const computeDiscountRate = (
  transactions: TransactionHeader[],
  currency: Money['currency']
): DiscountRateResult => {
  const completed = transactions.filter((t) => t.status === 'COMPLETED');
  const grossRevenue = completed.reduce((sum, t) => addMoney(sum, t.subtotal), zeroMoney(currency));
  const totalDiscount = completed.reduce((sum, t) => addMoney(sum, t.discount), zeroMoney(currency));
  if (grossRevenue.amount.isZero()) return { rate: 'unknown', totalDiscount };
  return {
    rate: totalDiscount.amount.dividedBy(grossRevenue.amount).times(100).toDecimalPlaces(2).toNumber(),
    totalDiscount,
  };
};

export type RefundRateResult = { rate: UnknownOr<number>; totalRefunded: Money };

/**
 * `refund_rate` = `refunds / gross_revenue`. A `REFUNDED` transaction's own `total` is the refunded
 * amount (the reversed transaction's original total, per `sales_transactions.refundOfId`'s
 * convention — the refund row IS the reversal record, not a separate delta). Gross revenue in the
 * denominator is still computed over `COMPLETED` transactions only, matching `discount_rate`'s own
 * convention — a period consisting ENTIRELY of refunds (zero completed sales) has no meaningful
 * refund rate to report, even though refunds occurred, since there is nothing to rate them against.
 */
export const computeRefundRate = (
  transactions: TransactionHeader[],
  currency: Money['currency']
): RefundRateResult => {
  const grossRevenue = transactions
    .filter((t) => t.status === 'COMPLETED')
    .reduce((sum, t) => addMoney(sum, t.subtotal), zeroMoney(currency));
  const totalRefunded = transactions
    .filter((t) => t.status === 'REFUNDED')
    .reduce((sum, t) => addMoney(sum, t.total), zeroMoney(currency));
  if (grossRevenue.amount.isZero()) return { rate: 'unknown', totalRefunded };
  return {
    rate: totalRefunded.amount.dividedBy(grossRevenue.amount).times(100).toDecimalPlaces(2).toNumber(),
    totalRefunded,
  };
};

/* ------------------------------------------------------------------ mix */

export type ItemSaleLine = {
  itemId: string | null;
  itemName: string | null;
  lineTotal: Money;
};

export type SalesMixEntry = { itemId: string | null; itemName: string; revenue: Money; percentage: number };

/**
 * `sales_mix_percentage` = item revenue / total revenue, grouped by POS item. A line with no
 * `itemId` at all (schema allows it) is grouped under a real `null` key labeled "Unmapped," not
 * dropped — dropping it would make the percentages fail to sum to 100%, silently understating the
 * true mix. Returns an empty array, not `'unknown'`, for zero revenue — there is no mix to report,
 * which is a real (if uninteresting) empty state, not an undefined one.
 */
export const computeSalesMix = (lines: ItemSaleLine[], currency: Money['currency']): SalesMixEntry[] => {
  const totalRevenue = lines.reduce((sum, l) => addMoney(sum, l.lineTotal), zeroMoney(currency));
  if (totalRevenue.amount.isZero()) return [];

  const byItem = new Map<string, { itemName: string; revenue: Money }>();
  for (const line of lines) {
    const key = line.itemId ?? '__unmapped__';
    const itemName = line.itemName ?? 'Unmapped';
    const existing = byItem.get(key);
    byItem.set(key, {
      itemName,
      revenue: existing ? addMoney(existing.revenue, line.lineTotal) : line.lineTotal,
    });
  }

  return [...byItem.entries()]
    .map(([key, { itemName, revenue }]) => ({
      itemId: key === '__unmapped__' ? null : key,
      itemName,
      revenue,
      percentage: revenue.amount.dividedBy(totalRevenue.amount).times(100).toDecimalPlaces(2).toNumber(),
    }))
    .sort((a, b) => compareMoney(b.revenue, a.revenue));
};

/* ------------------------------------------------------------------ dayparts */

export type DaypartSaleLine = { occurredAt: Date; lineTotal: Money };

export type DaypartRevenue = Record<Daypart, Money>;

/**
 * `revenue_per_daypart` — net revenue bucketed by LOCAL-time daypart (the design: "Must use store
 * timezone," the design: "dayparts computed in UTC are simply wrong"). Every line's `occurredAt`
 * (a UTC instant) is resolved to the store's own wall-clock daypart via `resolveLocalDaypart`
 * before being summed — this is the ONE place that conversion happens, so a line occurring at
 * 23:45 local on a store in `America/Los_Angeles` is never miscounted into UTC's own, different,
 * daypart.
 */
export const computeRevenuePerDaypart = (
  lines: DaypartSaleLine[],
  timezone: string,
  currency: Money['currency']
): DaypartRevenue => {
  const result: DaypartRevenue = {
    BREAKFAST: zeroMoney(currency),
    LUNCH: zeroMoney(currency),
    DINNER: zeroMoney(currency),
    LATE_NIGHT: zeroMoney(currency),
  };
  for (const line of lines) {
    const daypart = resolveLocalDaypart(line.occurredAt, timezone);
    result[daypart] = addMoney(result[daypart], line.lineTotal);
  }
  return result;
};
