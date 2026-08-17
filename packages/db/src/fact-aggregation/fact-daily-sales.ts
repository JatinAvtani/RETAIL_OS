import { Decimal } from 'decimal.js';
import { generateId } from '@retailos/domain';
import { resolveLocalDaypart, type StoreTimezone } from '@retailos/domain';

/**
 * `fact_daily_sales`'s pure aggregation (009-01) — real source rows (already fetched, real
 * `DashboardRepository` queries) in, real fact rows out. No database access here, matching every
 * `packages/metrics` `compute*` function's own precedent: fetch-then-compute, kept separate so the
 * math is testable without Postgres.
 */

export type SalesLineForAggregation = {
  transactionId: string;
  occurredAt: Date;
  channel: string | null;
  transactionSubtotal: string;
  transactionDiscount: string;
  lineTotal: string;
  quantity: string;
  menuItemId: string | null;
  posItemCategory: string | null;
};

export type RefundForAggregation = {
  originalTransactionId: string;
  refundTotal: string;
};

export type FactDailySalesRow = {
  id: string;
  date: string;
  menuItemId: string | null;
  posItemCategory: string | null;
  channel: string | null;
  daypart: string | null;
  units: string;
  grossRevenue: string;
  discounts: string;
  refunds: string;
  netRevenue: string;
  transactionCount: number;
};

/**
 * Aggregates real sales lines (already scoped to one store's one resolved local day) into
 * `fact_daily_sales` rows, grouped by (menuItemId, posItemCategory, channel, daypart) — the exact
 * grain the table's own unique index enforces. `date` is passed in explicitly (the resolved local
 * calendar date), not derived from `occurredAt`, since a line's UTC `occurredAt` could format to a
 * DIFFERENT calendar date in a different timezone than the one this aggregation run is for — the
 * caller already scoped the query to the correct `[from, to)` window, so every line handed in here
 * genuinely belongs to this exact local date, and re-deriving it independently would risk disagreeing
 * with the caller's own boundary.
 *
 * Discount/refund proration: neither is itemized per line in the source schema (both are
 * transaction-header fields). Each line's discount/refund SHARE is `(lineTotal / transactionSubtotal)
 * * transactionDiscount` (or `refundTotal`) — confirmed with the user over leaving item-grain
 * discounts/refunds at zero. A transaction with a real zero subtotal has no meaningful share to
 * prorate (I7: a $0 subtotal transaction contributes $0 discount/refund share to every one of its
 * lines, not a NaN or an evenly-split guess) — `computeFactDailySales`'s own property test (see the
 * test file) proves every line's prorated shares SUM EXACTLY back to the real transaction-level
 * discount/refund totals, so nothing is lost in the aggregate even though any single line's number
 * is an estimate of its true share.
 */
export const computeFactDailySales = (
  date: string,
  lines: SalesLineForAggregation[],
  refunds: RefundForAggregation[],
  timezone: StoreTimezone
): FactDailySalesRow[] => {
  const refundByTransactionId = new Map<string, Decimal>();
  for (const refund of refunds) {
    const existing = refundByTransactionId.get(refund.originalTransactionId) ?? new Decimal(0);
    refundByTransactionId.set(refund.originalTransactionId, existing.plus(refund.refundTotal));
  }

  type GroupKey = string;
  type Group = {
    menuItemId: string | null;
    posItemCategory: string | null;
    channel: string | null;
    daypart: string | null;
    units: Decimal;
    grossRevenue: Decimal;
    discounts: Decimal;
    refunds: Decimal;
    transactionIds: Set<string>;
  };
  const groups = new Map<GroupKey, Group>();

  for (const line of lines) {
    const daypart = resolveLocalDaypart(line.occurredAt, timezone);
    const key: GroupKey = JSON.stringify([line.menuItemId, line.posItemCategory, line.channel, daypart]);

    const subtotal = new Decimal(line.transactionSubtotal);
    const lineTotal = new Decimal(line.lineTotal);
    const revenueShare = subtotal.isZero() ? new Decimal(0) : lineTotal.dividedBy(subtotal);

    const discountShare = revenueShare.times(line.transactionDiscount);
    const totalRefundForTransaction = refundByTransactionId.get(line.transactionId) ?? new Decimal(0);
    const refundShare = revenueShare.times(totalRefundForTransaction);

    const existing = groups.get(key) ?? {
      menuItemId: line.menuItemId,
      posItemCategory: line.posItemCategory,
      channel: line.channel,
      daypart,
      units: new Decimal(0),
      grossRevenue: new Decimal(0),
      discounts: new Decimal(0),
      refunds: new Decimal(0),
      transactionIds: new Set<string>(),
    };
    existing.units = existing.units.plus(line.quantity);
    existing.grossRevenue = existing.grossRevenue.plus(lineTotal);
    existing.discounts = existing.discounts.plus(discountShare);
    existing.refunds = existing.refunds.plus(refundShare);
    existing.transactionIds.add(line.transactionId);
    groups.set(key, existing);
  }

  return [...groups.values()].map((group) => {
    const netRevenue = group.grossRevenue.minus(group.discounts).minus(group.refunds);
    return {
      id: generateId(),
      date,
      menuItemId: group.menuItemId,
      posItemCategory: group.posItemCategory,
      channel: group.channel,
      daypart: group.daypart,
      units: group.units.toFixed(6),
      grossRevenue: group.grossRevenue.toFixed(4),
      discounts: group.discounts.toFixed(4),
      refunds: group.refunds.toFixed(4),
      netRevenue: netRevenue.toFixed(4),
      transactionCount: group.transactionIds.size,
    };
  });
};
