import { z } from 'zod';
import Decimal from 'decimal.js';
import { money, type CurrencyCode, type Money } from '@retailos/domain';
import { DashboardRepository } from '@retailos/db';
import { defineMetric, resolveCurrency, type MetricContext, type MetricResult } from '../catalog/index.js';
import {
  computeCogsActual,
  computeCogsTheoretical,
  computeContributionMargin,
  computeContributionMarginPercentage,
  computeCostVariance,
  computeFoodCostPercentage,
  computeNetRevenue,
  computeWasteBreakdown,
  type ConsumptionLine,
  type SoldItemLine,
  type WasteLine,
} from './margin.js';

/**
 * The margin metrics, registered into the catalog. Each `execute` does exactly what
 * `apps/api`'s dashboard router used to do inline: fetch already-period/store-bounded rows via
 * `DashboardRepository`, then hand them to the pure `compute*` functions from `margin.ts` — no
 * arithmetic on a business number happens in this file either. Registering them here (rather than
 * leaving the fetch-then-compute logic embedded in one router) is what makes "dashboard and AI
 * produce identical values" true by construction: both call `executeMetric('net_revenue', ...)`,
 * not two independently-written code paths that happen to agree today.
 *
 * `storeId` is required on every metric here (not the full `storeIds` scope) because every
 * underlying `DashboardRepository` method is single-store-bounded — a cross-store rollup is a
 * genuinely different, unbuilt aggregation (009-01's fact tables), not a trivial loop over stores.
 *
 * `resolveRecipeUnitCost` (009-01, `../recipes/recipe-cost-resolver.js`) is passed on `MetricContext`
 * rather than called directly here: this module stays free of concrete repository wiring
 * (`RecipeRepository`, `ProductRepository`, etc. construction), taking its collaborators as
 * parameters instead — matching how `PostingService`/`MovementService` already take collaborators
 * as parameters rather than reaching for concrete construction inline.
 */

const marginMetricParams = z.object({
  storeId: z.string().uuid(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});

export type MarginMetricParams = z.infer<typeof marginMetricParams>;

export type RecipeUnitCostResolver = (
  ctx: MetricContext,
  recipeGroupId: string,
  currency: CurrencyCode
) => Promise<Money | 'unknown'>;

/** `MetricContext` extended with the one metric-specific collaborator `cogs_theoretical` needs. */
export type MarginMetricContext = MetricContext & {
  resolveRecipeUnitCost: RecipeUnitCostResolver;
};

const isMarginMetricContext = (ctx: MetricContext): ctx is MarginMetricContext =>
  typeof (ctx as Partial<MarginMetricContext>).resolveRecipeUnitCost === 'function';

export const requireMarginContext = (ctx: MetricContext, metricId: string): MarginMetricContext => {
  if (!isMarginMetricContext(ctx)) {
    throw new Error(
      `Metric '${metricId}' requires a MarginMetricContext (with resolveRecipeUnitCost) — plain MetricContext is insufficient.`
    );
  }
  return ctx;
};

const serialize = (value: Money | 'unknown'): string | 'unknown' =>
  value === 'unknown' ? 'unknown' : value.amount.toFixed(4);

const period = (params: MarginMetricParams) => ({ from: params.from, to: params.to });

export const fetchConsumptionLines = async (
  dashboard: DashboardRepository,
  params: MarginMetricParams,
  currency: CurrencyCode
): Promise<ConsumptionLine[]> => {
  const consumption = await dashboard.findConsumption(params.storeId, params.from, params.to);
  return consumption.map((row) => {
    const quantity = new Decimal(row.quantity).abs();
    return {
      productId: row.productId,
      quantity: quantity.toFixed(6),
      cost:
        row.unitCost === null
          ? ('unknown' as const)
          : money(new Decimal(row.unitCost).times(quantity), currency),
    };
  });
};

const fetchSoldItemLines = async (
  ctx: MarginMetricContext,
  dashboard: DashboardRepository,
  params: MarginMetricParams,
  currency: CurrencyCode
): Promise<SoldItemLine[]> => {
  const soldMapped = await dashboard.findSoldMappedItems(params.storeId, params.from, params.to);
  const lines: SoldItemLine[] = [];
  for (const sold of soldMapped) {
    const unitRecipeCost = await ctx.resolveRecipeUnitCost(ctx, sold.menuItemId, currency);
    lines.push({ menuItemId: sold.menuItemId, quantitySold: sold.quantitySold, unitRecipeCost });
  }
  return lines;
};

const fetchWasteLines = async (
  dashboard: DashboardRepository,
  params: MarginMetricParams,
  currency: CurrencyCode
): Promise<WasteLine[]> => {
  const waste = await dashboard.findWaste(params.storeId, params.from, params.to);
  return waste.map((row) => {
    const quantity = new Decimal(row.quantity).abs();
    return {
      reasonCode: row.reasonCode!,
      value:
        row.unitCost === null
          ? ('unknown' as const)
          : money(new Decimal(row.unitCost).times(quantity), currency),
    };
  });
};

export const netRevenueMetric = defineMetric<MarginMetricParams>({
  id: 'net_revenue',
  description: 'Total sales revenue in the period, net of discounts and refunds.',
  parameters: marginMetricParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'sales_transactions'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const salesLines = await dashboard.findSalesLines(params.storeId, params.from, params.to);
    const netRevenue = computeNetRevenue(
      salesLines.map((line) => money(line.lineTotal, currency)),
      currency
    );
    return {
      metricId: 'net_revenue',
      value: serialize(netRevenue),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'sales_transaction_lines', rowCount: salesLines.length }],
    };
  },
});

export const cogsActualMetric = defineMetric<MarginMetricParams>({
  id: 'cogs_actual',
  description: 'What consumed stock genuinely cost, from the lots FEFO actually drew from.',
  parameters: marginMetricParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['stock_movements'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const consumptionLines = await fetchConsumptionLines(dashboard, params, currency);
    const cogsActual = computeCogsActual(consumptionLines, currency);
    return {
      metricId: 'cogs_actual',
      value: serialize(cogsActual),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'stock_movements', rowCount: consumptionLines.length }],
      ...(cogsActual === 'unknown'
        ? { unknownReason: 'One or more consumed lots had no known cost.' }
        : {}),
    };
  },
});

export const cogsTheoreticalMetric = defineMetric<MarginMetricParams>({
  id: 'cogs_theoretical',
  description: 'What sold items should have cost, from recipe costs.',
  parameters: marginMetricParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'pos_items', 'recipes'],
  async execute(params, rawCtx): Promise<MetricResult> {
    const ctx = requireMarginContext(rawCtx, 'cogs_theoretical');
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const soldItemLines = await fetchSoldItemLines(ctx, dashboard, params, currency);
    const cogsTheoretical = computeCogsTheoretical(soldItemLines, currency);
    return {
      metricId: 'cogs_theoretical',
      value: serialize(cogsTheoretical),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'sales_transaction_lines', rowCount: soldItemLines.length }],
      ...(cogsTheoretical === 'unknown'
        ? { unknownReason: 'One or more sold items had no fully-resolvable recipe cost.' }
        : {}),
    };
  },
});

export const costVarianceMetric = defineMetric<MarginMetricParams>({
  id: 'cost_variance',
  description: 'The gap between actual and theoretical COGS — waste, shrinkage, and portioning error combined.',
  parameters: marginMetricParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['stock_movements', 'sales_transaction_lines', 'recipes'],
  async execute(params, rawCtx): Promise<MetricResult> {
    const ctx = requireMarginContext(rawCtx, 'cost_variance');
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const [consumptionLines, soldItemLines] = await Promise.all([
      fetchConsumptionLines(dashboard, params, currency),
      fetchSoldItemLines(ctx, dashboard, params, currency),
    ]);
    const cogsActual = computeCogsActual(consumptionLines, currency);
    const cogsTheoretical = computeCogsTheoretical(soldItemLines, currency);
    const { variance } = computeCostVariance(cogsActual, cogsTheoretical);
    return {
      metricId: 'cost_variance',
      value: serialize(variance),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [
        { table: 'stock_movements', rowCount: consumptionLines.length },
        { table: 'sales_transaction_lines', rowCount: soldItemLines.length },
      ],
      ...(variance === 'unknown' ? { unknownReason: 'Actual or theoretical COGS is unknown.' } : {}),
    };
  },
});

export const contributionMarginMetric = defineMetric<MarginMetricParams>({
  id: 'contribution_margin',
  description: 'Net revenue minus actual cost of goods sold — not "profit"; rent, labour, and tax are out of scope.',
  parameters: marginMetricParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'stock_movements'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const [salesLines, consumptionLines] = await Promise.all([
      dashboard.findSalesLines(params.storeId, params.from, params.to),
      fetchConsumptionLines(dashboard, params, currency),
    ]);
    const netRevenue = computeNetRevenue(
      salesLines.map((line) => money(line.lineTotal, currency)),
      currency
    );
    const cogsActual = computeCogsActual(consumptionLines, currency);
    const contributionMargin = computeContributionMargin(netRevenue, cogsActual);
    return {
      metricId: 'contribution_margin',
      value: serialize(contributionMargin),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [
        { table: 'sales_transaction_lines', rowCount: salesLines.length },
        { table: 'stock_movements', rowCount: consumptionLines.length },
      ],
      ...(contributionMargin === 'unknown' ? { unknownReason: 'Actual COGS is unknown.' } : {}),
    };
  },
});

export const foodCostPercentageMetric = defineMetric<MarginMetricParams>({
  id: 'food_cost_percentage',
  description: 'Cost of goods sold as a percentage of net revenue — the headline cost metric in food service.',
  parameters: marginMetricParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'stock_movements'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const [salesLines, consumptionLines] = await Promise.all([
      dashboard.findSalesLines(params.storeId, params.from, params.to),
      fetchConsumptionLines(dashboard, params, currency),
    ]);
    const netRevenue = computeNetRevenue(
      salesLines.map((line) => money(line.lineTotal, currency)),
      currency
    );
    const cogsActual = computeCogsActual(consumptionLines, currency);
    const foodCostPercentage = computeFoodCostPercentage(cogsActual, netRevenue);
    return {
      metricId: 'food_cost_percentage',
      value: foodCostPercentage === 'unknown' ? 'unknown' : foodCostPercentage.toFixed(2),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [
        { table: 'sales_transaction_lines', rowCount: salesLines.length },
        { table: 'stock_movements', rowCount: consumptionLines.length },
      ],
      ...(foodCostPercentage === 'unknown'
        ? { unknownReason: 'Actual COGS is unknown, or net revenue is zero.' }
        : {}),
    };
  },
});

export const contributionMarginPercentageMetric = defineMetric<MarginMetricParams>({
  id: 'contribution_margin_percentage',
  description: 'Contribution margin as a percentage of net revenue.',
  parameters: marginMetricParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'stock_movements'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const [salesLines, consumptionLines] = await Promise.all([
      dashboard.findSalesLines(params.storeId, params.from, params.to),
      fetchConsumptionLines(dashboard, params, currency),
    ]);
    const netRevenue = computeNetRevenue(
      salesLines.map((line) => money(line.lineTotal, currency)),
      currency
    );
    const cogsActual = computeCogsActual(consumptionLines, currency);
    const contributionMargin = computeContributionMargin(netRevenue, cogsActual);
    const pct = computeContributionMarginPercentage(contributionMargin, netRevenue);
    return {
      metricId: 'contribution_margin_percentage',
      value: pct === 'unknown' ? 'unknown' : pct.toFixed(2),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [
        { table: 'sales_transaction_lines', rowCount: salesLines.length },
        { table: 'stock_movements', rowCount: consumptionLines.length },
      ],
      ...(pct === 'unknown'
        ? { unknownReason: 'Contribution margin is unknown, or net revenue is zero.' }
        : {}),
    };
  },
});

export const wasteValueMetric = defineMetric<MarginMetricParams>({
  id: 'waste_value',
  description: 'Total value of wasted stock in the period, across all reasons.',
  parameters: marginMetricParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['stock_movements'],
  async execute(params, ctx): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const wasteLines = await fetchWasteLines(dashboard, params, currency);
    const breakdown = computeWasteBreakdown(wasteLines, currency);
    return {
      metricId: 'waste_value',
      value: serialize(breakdown.total),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [{ table: 'stock_movements', rowCount: wasteLines.length }],
      ...(breakdown.total === 'unknown'
        ? {
            unknownReason: `${breakdown.unknownCostEventCount} of ${wasteLines.length} waste events had no known cost.`,
          }
        : {}),
    };
  },
});
