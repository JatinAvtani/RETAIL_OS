import { z } from 'zod';
import { money, type CurrencyCode } from '@retailos/domain';
import { DashboardRepository } from '@retailos/db';
import { defineMetric, type MetricResult } from '../catalog/index.js';
import { computeCogsActual, computeFoodCostPercentage, computeNetRevenue } from './margin.js';
import { requireMarginContext, fetchConsumptionLines, type MarginMetricParams } from './catalog-entries.js';

/**
 * Sparkline-shaped trend metrics for the owner dashboard (spec 12 §12.5, `009-14`) —
 * `net_revenue_trend`/`food_cost_percentage_trend`, matching `margin_trend`'s own established
 * series shape exactly (a real `points` array alongside a real scalar `value`, the last known point
 * — the same `MetricResult`-extension pattern used throughout this catalog rather than a new
 * parallel primitive). `contribution_margin_percentage` already has this shape via `margin_trend`;
 * `stock_value_trend` lives in `inventory/catalog-entries.ts` since it needs `StockLevelRepository`,
 * not this file's margin collaborators.
 */

const CURRENCY: CurrencyCode = 'USD';

const trendParams = z.object({
  storeId: z.string().uuid(),
  periods: z.array(z.object({ label: z.string(), from: z.coerce.date(), to: z.coerce.date() })).min(1),
});
type TrendParams = z.infer<typeof trendParams>;

export type NetRevenueTrendMetricResult = MetricResult & {
  points: Array<{ periodLabel: string; value: string }>;
};

export const netRevenueTrendMetric = defineMetric<TrendParams>({
  id: 'net_revenue_trend',
  description: 'Net revenue over a rolling series of periods — the owner dashboard sparkline input.',
  parameters: trendParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines'],
  async execute(params, ctx): Promise<NetRevenueTrendMetricResult> {
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const points = await Promise.all(
      params.periods.map(async (p) => {
        const salesLines = await dashboard.findSalesLines(params.storeId, p.from, p.to);
        const netRevenue = computeNetRevenue(
          salesLines.map((line) => money(line.lineTotal, CURRENCY)),
          CURRENCY
        );
        return { periodLabel: p.label, value: netRevenue.amount.toFixed(4) };
      })
    );
    const now = new Date();
    const last = points[points.length - 1]!;
    return {
      metricId: 'net_revenue_trend',
      value: last.value,
      unit: 'CURRENCY',
      period: { from: params.periods[0]!.from, to: params.periods[params.periods.length - 1]!.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'sales_transaction_lines', rowCount: points.length }],
      points,
    };
  },
});

export type FoodCostPercentageTrendMetricResult = MetricResult & {
  points: Array<{ periodLabel: string; value: string | 'unknown' }>;
};

export const foodCostPercentageTrendMetric = defineMetric<TrendParams>({
  id: 'food_cost_percentage_trend',
  description: 'Food cost percentage over a rolling series of periods — the owner dashboard sparkline input.',
  parameters: trendParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'stock_movements'],
  async execute(params, rawCtx): Promise<FoodCostPercentageTrendMetricResult> {
    const ctx = requireMarginContext(rawCtx, 'food_cost_percentage_trend');
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const points = await Promise.all(
      params.periods.map(async (p): Promise<{ periodLabel: string; value: string | 'unknown' }> => {
        const periodParams: MarginMetricParams = { storeId: params.storeId, from: p.from, to: p.to };
        const [salesLines, consumptionLines] = await Promise.all([
          dashboard.findSalesLines(params.storeId, p.from, p.to),
          fetchConsumptionLines(dashboard, periodParams),
        ]);
        const netRevenue = computeNetRevenue(
          salesLines.map((line) => money(line.lineTotal, CURRENCY)),
          CURRENCY
        );
        const cogsActual = computeCogsActual(consumptionLines, CURRENCY);
        const foodCostPercentage = computeFoodCostPercentage(cogsActual, netRevenue);
        return { periodLabel: p.label, value: foodCostPercentage === 'unknown' ? 'unknown' : foodCostPercentage.toFixed(2) };
      })
    );
    const now = new Date();
    const lastKnown = [...points].reverse().find((p) => p.value !== 'unknown');
    return {
      metricId: 'food_cost_percentage_trend',
      value: lastKnown ? lastKnown.value : 'unknown',
      unit: 'PERCENTAGE',
      period: { from: params.periods[0]!.from, to: params.periods[params.periods.length - 1]!.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'sales_transaction_lines', rowCount: points.length }],
      points,
      ...(!lastKnown ? { unknownReason: 'No period in the requested series has a computable food cost percentage.' } : {}),
    };
  },
});
