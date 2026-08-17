import { z } from 'zod';
import Decimal from 'decimal.js';
import { money, type CurrencyCode } from '@retailos/domain';
import { DashboardRepository, StoreRepository } from '@retailos/db';
import { defineMetric, resolveCurrency, type MetricResult } from '../catalog/index.js';
import {
  computeAverageTransactionValue,
  computeDiscountRate,
  computeGrossRevenue,
  computeRefundRate,
  computeRevenuePerDaypart,
  computeSalesMix,
  computeTransactionCount,
  computeUnitsSold,
  type TransactionHeader,
} from './sales.js';

/**
 * Sales metrics registered into the catalog (spec 12 §A) — `net_revenue` is already registered in
 * `margin/catalog-entries.ts` (it was built first, for the dashboard); the other 8 live here. Every
 * `execute` follows the same fetch-then-compute split as the margin entries: `DashboardRepository`
 * fetches period/store-bounded rows, the pure `compute*` functions in `sales.ts` do the arithmetic.
 *
 * `revenue_per_daypart` is the one metric here needing the store's own timezone (spec 12 §A:
 * "Must use store timezone") — its `execute` looks up `stores.timezone` directly via a plain
 * tenant-scoped query, the one piece of context none of the other sales metrics need.
 */

const salesMetricParams = z.object({
  storeId: z.string().uuid(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});

type SalesMetricParams = z.infer<typeof salesMetricParams>;

const period = (params: SalesMetricParams) => ({ from: params.from, to: params.to });

const toTransactionHeaders = (
  rows: Awaited<ReturnType<DashboardRepository['findTransactions']>>,
  currency: CurrencyCode
): TransactionHeader[] =>
  rows.map((row) => ({
    occurredAt: row.occurredAt,
    subtotal: money(row.subtotal, currency),
    discount: money(row.discount, currency),
    tax: money(row.tax, currency),
    total: money(row.total, currency),
    status: row.status,
  }));

export const grossRevenueMetric = defineMetric<SalesMetricParams>({
  id: 'gross_revenue',
  description: 'Total sales revenue before discounts, over completed transactions in the period.',
  parameters: salesMetricParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transactions'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const rows = await dashboard.findTransactions(params.storeId, params.from, params.to);
    const grossRevenue = computeGrossRevenue(toTransactionHeaders(rows, currency), currency);
    return {
      metricId: 'gross_revenue',
      value: grossRevenue.amount.toFixed(4),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'sales_transactions', rowCount: rows.length }],
    };
  },
});

export const transactionCountMetric = defineMetric<SalesMetricParams>({
  id: 'transaction_count',
  description: 'Count of completed transactions ("covers") in the period.',
  parameters: salesMetricParams,
  unit: 'COUNT',
  requiredPermission: 'financial:read',
  sources: ['sales_transactions'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const rows = await dashboard.findTransactions(params.storeId, params.from, params.to);
    const count = computeTransactionCount(toTransactionHeaders(rows, currency));
    return {
      metricId: 'transaction_count',
      value: String(count),
      unit: 'COUNT',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'sales_transactions', rowCount: rows.length }],
    };
  },
});

export const averageTransactionValueMetric = defineMetric<SalesMetricParams>({
  id: 'average_transaction_value',
  description: 'Net revenue divided by transaction count — the primary lever most owners can influence.',
  parameters: salesMetricParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transactions', 'sales_transaction_lines'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const [salesLines, transactionRows] = await Promise.all([
      dashboard.findSalesLines(params.storeId, params.from, params.to),
      dashboard.findTransactions(params.storeId, params.from, params.to),
    ]);
    const netRevenue = salesLines.reduce((sum, line) => sum.plus(line.lineTotal), new Decimal(0));
    const transactionCount = computeTransactionCount(toTransactionHeaders(transactionRows, currency));
    const avg = computeAverageTransactionValue(money(netRevenue, currency), transactionCount);
    return {
      metricId: 'average_transaction_value',
      value: avg === 'unknown' ? 'unknown' : avg.amount.toFixed(4),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [
        { table: 'sales_transaction_lines', rowCount: salesLines.length },
        { table: 'sales_transactions', rowCount: transactionRows.length },
      ],
      ...(avg === 'unknown' ? { unknownReason: 'No completed transactions in the period.' } : {}),
    };
  },
});

export const unitsSoldMetric = defineMetric<SalesMetricParams>({
  id: 'units_sold',
  description: 'Total quantity of items sold in the period, across completed transactions.',
  parameters: salesMetricParams,
  unit: 'COUNT',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines'],
  async execute(params, ctx): Promise<MetricResult> {
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const salesLines = await dashboard.findSalesLines(params.storeId, params.from, params.to);
    const unitsSold = computeUnitsSold(salesLines.map((line) => line.quantity));
    return {
      metricId: 'units_sold',
      value: unitsSold,
      unit: 'COUNT',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'sales_transaction_lines', rowCount: salesLines.length }],
    };
  },
});

export const discountRateMetric = defineMetric<SalesMetricParams>({
  id: 'discount_rate',
  description: 'Discounts as a percentage of gross revenue — detects excessive discounting.',
  parameters: salesMetricParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'financial:read',
  sources: ['sales_transactions'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const rows = await dashboard.findTransactions(params.storeId, params.from, params.to);
    const { rate } = computeDiscountRate(toTransactionHeaders(rows, currency), currency);
    return {
      metricId: 'discount_rate',
      value: rate === 'unknown' ? 'unknown' : rate.toFixed(2),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'sales_transactions', rowCount: rows.length }],
      ...(rate === 'unknown' ? { unknownReason: 'No gross revenue in the period.' } : {}),
    };
  },
});

export const refundRateMetric = defineMetric<SalesMetricParams>({
  id: 'refund_rate',
  description: 'Refunds as a percentage of gross revenue — a quality/dispute signal.',
  parameters: salesMetricParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'financial:read',
  sources: ['sales_transactions'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const rows = await dashboard.findTransactions(params.storeId, params.from, params.to);
    const { rate } = computeRefundRate(toTransactionHeaders(rows, currency), currency);
    return {
      metricId: 'refund_rate',
      value: rate === 'unknown' ? 'unknown' : rate.toFixed(2),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'sales_transactions', rowCount: rows.length }],
      ...(rate === 'unknown' ? { unknownReason: 'No gross revenue in the period.' } : {}),
    };
  },
});

/**
 * `sales_mix_percentage` doesn't fit `MetricResult`'s single scalar `value` shape — it's genuinely
 * a breakdown, not one number. Registered with `value` as the top mix entry's percentage (the
 * single most useful scalar if a caller only reads `.value`) and the FULL breakdown in a
 * `breakdown`-shaped array via `provenance`'s sibling — matching spec 10 §10.3's own
 * `MetricResult.breakdown?: MetricResult[]` field would require each entry to be a full nested
 * MetricResult, which is more machinery than this needs; instead the full list is returned
 * alongside `value` in a dedicated wider result type, consumed directly by anything (a future
 * dashboard panel) that needs the whole mix rather than just the top line.
 */
export type SalesMixMetricResult = MetricResult & {
  mix: ReturnType<typeof computeSalesMix>;
};

export const salesMixPercentageMetric = defineMetric<SalesMetricParams>({
  id: 'sales_mix_percentage',
  description: 'Each item\'s revenue as a percentage of total revenue — input to mix-shift attribution.',
  parameters: salesMetricParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'pos_items'],
  async execute(params, ctx): Promise<SalesMixMetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const lines = await dashboard.findSalesLinesWithItem(params.storeId, params.from, params.to);
    const mix = computeSalesMix(
      lines.map((line) => ({
        itemId: line.itemId,
        itemName: line.itemName,
        lineTotal: money(line.lineTotal, currency),
      })),
      currency
    );
    const top = mix[0];
    return {
      metricId: 'sales_mix_percentage',
      value: top ? top.percentage.toFixed(2) : 'unknown',
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'sales_transaction_lines', rowCount: lines.length }],
      mix,
      ...(!top ? { unknownReason: 'No sales in the period.' } : {}),
    };
  },
});

export type RevenuePerDaypartMetricResult = MetricResult & {
  byDaypart: Record<'BREAKFAST' | 'LUNCH' | 'DINNER' | 'LATE_NIGHT', string>;
};

export const revenuePerDaypartMetric = defineMetric<SalesMetricParams>({
  id: 'revenue_per_daypart',
  description: 'Net revenue bucketed by local-time daypart (breakfast/lunch/dinner/late night).',
  parameters: salesMetricParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'stores'],
  async execute(params, ctx): Promise<RevenuePerDaypartMetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const storeRepository = new StoreRepository(ctx.db, ctx.organizationId);
    const store = await storeRepository.findById(params.storeId);
    if (!store) {
      throw new Error(`Store '${params.storeId}' not found for revenue_per_daypart.`);
    }

    const salesLines = await dashboard.findSalesLines(params.storeId, params.from, params.to);
    const byDaypart = computeRevenuePerDaypart(
      salesLines.map((line) => ({ occurredAt: line.occurredAt, lineTotal: money(line.lineTotal, currency) })),
      store.timezone,
      currency
    );

    // `value` holds the sum across all four dayparts — a real, meaningful scalar (it equals the
    // period's total net revenue) rather than an arbitrary single bucket — while `byDaypart` below
    // carries the actual breakdown this metric exists to produce.
    const total = byDaypart.BREAKFAST.amount
      .plus(byDaypart.LUNCH.amount)
      .plus(byDaypart.DINNER.amount)
      .plus(byDaypart.LATE_NIGHT.amount);

    return {
      metricId: 'revenue_per_daypart',
      value: total.toFixed(4),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [
        { table: 'sales_transaction_lines', rowCount: salesLines.length },
        { table: 'stores', rowCount: 1 },
      ],
      byDaypart: {
        BREAKFAST: byDaypart.BREAKFAST.amount.toFixed(4),
        LUNCH: byDaypart.LUNCH.amount.toFixed(4),
        DINNER: byDaypart.DINNER.amount.toFixed(4),
        LATE_NIGHT: byDaypart.LATE_NIGHT.amount.toFixed(4),
      },
    };
  },
});
