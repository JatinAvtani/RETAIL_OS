import { z } from 'zod';
import { Decimal } from 'decimal.js';
import {
  DashboardRepository,
  MenuItemRepository,
  SupplierPriceRepository,
} from '@retailos/db';
import { defineMetric, type MetricContext, type MetricResult } from '../catalog/index.js';
import type { RecipeUnitCostResolver } from '../margin/catalog-entries.js';
import { computeCogsTheoretical, type SoldItemLine } from '../margin/margin.js';
import { computeConsumptionAnomalyDays, computeCostSpike, computeSalesAnomalies, computeWasteSpikes } from './anomaly.js';
import type { DailyPoint, FlaggedPoint } from './statistics.js';

/**
 * Anomaly detection metrics (spec 12 §12.4, `009-11`) — the 4 signals with a real underlying data
 * source in this codebase: `sales_anomaly`, `cost_spike`, `waste_spike`, `consumption_anomaly`.
 * `review_sentiment_shift` is deliberately not built (confirmed with the user — no review/sentiment
 * data source exists anywhere in this schema; see this file's own commit for the reasoning).
 *
 * Every result here extends `MetricResult` with a real `anomalies`/detail field, the same pattern
 * already established for `margin_attribution`/`sales_mix_percentage`/`revenue_per_daypart` — `value`
 * still carries a real, meaningful single number (the count of flagged points), never left null or
 * arbitrary just because the interesting payload is a list.
 */

const CURRENCY = 'USD' as const;

export type AnomalyMetricResult = MetricResult & { anomalies: FlaggedPoint[] };

/* ------------------------------------------------------------------ sales_anomaly */

const salesAnomalyParams = z.object({ storeId: z.string().uuid(), from: z.coerce.date(), to: z.coerce.date() });
type SalesAnomalyParams = z.infer<typeof salesAnomalyParams>;

export const salesAnomalyMetric = defineMetric<SalesAnomalyParams>({
  id: 'sales_anomaly',
  description: 'Days where completed sales revenue diverged sharply from its trend and day-of-week pattern — a real statistical outlier, not AI opinion.',
  parameters: salesAnomalyParams,
  unit: 'COUNT',
  requiredPermission: 'financial:read',
  sources: ['sales_transactions'],
  async execute(params, ctx: MetricContext): Promise<AnomalyMetricResult> {
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const rows = await dashboard.findDailyGrossRevenue(params.storeId, params.from, params.to);
    const series: DailyPoint[] = rows.map((r) => ({ date: r.date, value: new Decimal(r.totalSubtotal) }));
    const result = computeSalesAnomalies(series);
    const now = new Date();
    const anomalies = result === 'unknown' ? [] : result;
    return {
      metricId: 'sales_anomaly',
      value: result === 'unknown' ? 'unknown' : String(anomalies.length),
      unit: 'COUNT',
      period: { from: params.from, to: params.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'sales_transactions', rowCount: rows.length }],
      anomalies,
      ...(result === 'unknown'
        ? { unknownReason: `Fewer than 14 days of completed sales in the period — need at least 2 full weeks, have ${rows.length}.` }
        : {}),
    };
  },
});

/* ------------------------------------------------------------------ cost_spike */

const costSpikeParams = z.object({ supplierProductId: z.string().uuid() });
type CostSpikeParams = z.infer<typeof costSpikeParams>;

export const costSpikeMetric = defineMetric<CostSpikeParams>({
  id: 'cost_spike',
  description: 'Whether the most recent invoiced unit price for a supplier product is a statistical outlier against its own trailing price history.',
  parameters: costSpikeParams,
  unit: 'COUNT',
  requiredPermission: 'financial:read',
  sources: ['supplier_prices'],
  async execute(params, ctx: MetricContext): Promise<AnomalyMetricResult> {
    const supplierPriceRepository = new SupplierPriceRepository(ctx.db, ctx.organizationId);
    const history = await supplierPriceRepository.findHistory(params.supplierProductId);
    const points = history.map((h) => ({ date: h.validFrom.toISOString().slice(0, 10), unitPrice: h.unitPrice }));
    const result = computeCostSpike(points);
    const now = new Date();
    const latest = points.length > 0 ? points[points.length - 1] : undefined;
    const anomalies: FlaggedPoint[] =
      result !== 'unknown' && result.isSpike && latest
        ? [{ date: latest.date, value: result.percentChange, zScore: result.zScore }]
        : [];
    return {
      metricId: 'cost_spike',
      value: result === 'unknown' ? 'unknown' : String(anomalies.length),
      unit: 'COUNT',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'supplier_prices', rowCount: history.length }],
      anomalies,
      ...(result === 'unknown' ? { unknownReason: 'Fewer than 2 historical price points, or the median price is zero.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ waste_spike */

const wasteSpikeParams = z.object({ storeId: z.string().uuid(), from: z.coerce.date(), to: z.coerce.date() });
type WasteSpikeParams = z.infer<typeof wasteSpikeParams>;

export const wasteSpikeMetric = defineMetric<WasteSpikeParams>({
  id: 'waste_spike',
  description: 'Days where daily waste value was a statistical outlier against the trailing mean — a real spike, not routine variation.',
  parameters: wasteSpikeParams,
  unit: 'COUNT',
  requiredPermission: 'financial:read',
  sources: ['stock_movements'],
  async execute(params, ctx: MetricContext): Promise<AnomalyMetricResult> {
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const rows = await dashboard.findDailyWasteValue(params.storeId, params.from, params.to);
    const series: DailyPoint[] = rows.map((r) => ({ date: r.date, value: new Decimal(r.totalValue) }));
    const result = computeWasteSpikes(series);
    const now = new Date();
    const anomalies = result === 'unknown' ? [] : result;
    return {
      metricId: 'waste_spike',
      value: result === 'unknown' ? 'unknown' : String(anomalies.length),
      unit: 'COUNT',
      period: { from: params.from, to: params.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_movements', rowCount: rows.length }],
      anomalies,
      ...(result === 'unknown' ? { unknownReason: `Fewer than 2 days of waste in the period, have ${rows.length}.` } : {}),
    };
  },
});

/* ------------------------------------------------------------------ consumption_anomaly */

const consumptionAnomalyParams = z.object({ storeId: z.string().uuid(), from: z.coerce.date(), to: z.coerce.date() });
type ConsumptionAnomalyParams = z.infer<typeof consumptionAnomalyParams>;

/** `consumption_anomaly` needs `resolveRecipeUnitCost` — the same injected collaborator `cogs_theoretical`/`menu_item_cost` already depend on. */
export type ConsumptionAnomalyMetricContext = MetricContext & { resolveRecipeUnitCost: RecipeUnitCostResolver };

const requireConsumptionAnomalyContext = (ctx: MetricContext, metricId: string): ConsumptionAnomalyMetricContext => {
  const candidate = ctx as Partial<ConsumptionAnomalyMetricContext>;
  if (typeof candidate.resolveRecipeUnitCost !== 'function') {
    throw new Error(`Metric '${metricId}' requires a ConsumptionAnomalyMetricContext (with resolveRecipeUnitCost) — plain MetricContext is insufficient.`);
  }
  return ctx as ConsumptionAnomalyMetricContext;
};

export const consumptionAnomalyMetric = defineMetric<ConsumptionAnomalyParams>({
  id: 'consumption_anomaly',
  description: 'Days where actual vs. theoretical COGS diverged by more than 10%, sustained 3 consecutive days — a real production or portioning problem, not routine noise.',
  parameters: consumptionAnomalyParams,
  unit: 'COUNT',
  requiredPermission: 'financial:read',
  sources: ['stock_movements', 'sales_transaction_lines', 'recipes'],
  async execute(params, rawCtx): Promise<AnomalyMetricResult> {
    const ctx = requireConsumptionAnomalyContext(rawCtx, 'consumption_anomaly');
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const menuItemRepository = new MenuItemRepository(ctx.db, ctx.organizationId);

    const [actualRows, soldRows] = await Promise.all([
      dashboard.findDailyConsumptionCost(params.storeId, params.from, params.to),
      dashboard.findDailySoldMappedItems(params.storeId, params.from, params.to),
    ]);

    // Resolve each DISTINCT menu item's unit recipe cost exactly once for the whole window, not
    // once per day — see findDailySoldMappedItems's own doc comment for why.
    const distinctMenuItemIds = [...new Set(soldRows.map((r) => r.menuItemId))];
    const unitCostByMenuItem = new Map<string, Awaited<ReturnType<RecipeUnitCostResolver>>>();
    for (const menuItemId of distinctMenuItemIds) {
      const menuItem = await menuItemRepository.findById(menuItemId);
      const unitCost = menuItem ? await ctx.resolveRecipeUnitCost(ctx, menuItem.recipeGroupId, CURRENCY) : ('unknown' as const);
      unitCostByMenuItem.set(menuItemId, unitCost);
    }

    const theoreticalByDate = new Map<string, SoldItemLine[]>();
    for (const row of soldRows) {
      const lines = theoreticalByDate.get(row.date) ?? [];
      lines.push({
        menuItemId: row.menuItemId,
        quantitySold: row.quantitySold,
        unitRecipeCost: unitCostByMenuItem.get(row.menuItemId) ?? 'unknown',
      });
      theoreticalByDate.set(row.date, lines);
    }

    const actualByDate = new Map<string, Decimal>(actualRows.map((r) => [r.date, new Decimal(r.totalCost)]));
    const allDates = new Set([...actualByDate.keys(), ...theoreticalByDate.keys()]);

    const days = [...allDates]
      .map((date) => {
        const actual = actualByDate.get(date) ?? new Decimal(0);
        const soldLines = theoreticalByDate.get(date) ?? [];
        const theoreticalCogs = computeCogsTheoretical(soldLines, CURRENCY);
        return theoreticalCogs === 'unknown' ? null : { date, actual, theoretical: theoreticalCogs.amount };
      })
      .filter((d): d is { date: string; actual: Decimal; theoretical: Decimal } => d !== null);

    const flaggedDates = computeConsumptionAnomalyDays(days);
    const now = new Date();
    const anomalies: FlaggedPoint[] = flaggedDates.map((date) => {
      const day = days.find((d) => d.date === date)!;
      const divergence = day.theoretical.isZero() ? new Decimal(0) : day.actual.minus(day.theoretical).dividedBy(day.theoretical).times(100);
      return { date, value: day.actual.minus(day.theoretical).toFixed(4), zScore: divergence.toFixed(2) };
    });

    return {
      metricId: 'consumption_anomaly',
      value: String(anomalies.length),
      unit: 'COUNT',
      period: { from: params.from, to: params.to },
      computedAt: now,
      freshness: now,
      provenance: [
        { table: 'stock_movements', rowCount: actualRows.length },
        { table: 'sales_transaction_lines', rowCount: soldRows.length },
      ],
      anomalies,
    };
  },
});
