import { z } from 'zod';
import Decimal from 'decimal.js';
import { money, type CurrencyCode } from '@retailos/domain';
import { DashboardRepository, StockCountService } from '@retailos/db';
import { defineMetric, resolveCurrency, type MetricContext, type MetricResult } from '../catalog/index.js';
import { computeCogsActual, computeWasteBreakdown, type ConsumptionLine } from '../margin/margin.js';
import {
  computeExpiredValue,
  computeShrinkagePercentage,
  computeShrinkageValue,
  computeWastePercentage,
  computeWasteValueForReason,
  type ReasonCodedWasteLine,
  type VarianceLine,
} from './waste.js';

/**
 * Waste & shrinkage metrics registered into the catalog (the design, the 5 not already registered
 * by `margin/catalog-entries.ts`'s `wasteValueMetric`). Every `execute` follows the same
 * fetch-then-compute split as every other catalog file.
 */

const periodParams = z.object({
  storeId: z.string().uuid(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});
type PeriodParams = z.infer<typeof periodParams>;

const wasteReasonCodeEnum = [
  'EXPIRED',
  'DAMAGED',
  'PREP_ERROR',
  'CUSTOMER_RETURN',
  'OVERPRODUCTION',
  'SPILLAGE',
  'QUALITY_REJECT',
  'THEFT_SUSPECTED',
] as const;

const wasteReasonParams = z.object({
  storeId: z.string().uuid(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  reasonCode: z.enum(wasteReasonCodeEnum),
});
type WasteReasonParams = z.infer<typeof wasteReasonParams>;

const period = (params: PeriodParams) => ({ from: params.from, to: params.to });

const fetchConsumptionLines = async (
  dashboard: DashboardRepository,
  params: PeriodParams,
  currency: CurrencyCode
): Promise<ConsumptionLine[]> => {
  const consumption = await dashboard.findConsumption(params.storeId, params.from, params.to);
  return consumption.map((row) => {
    const quantity = new Decimal(row.quantity).abs();
    return {
      productId: row.productId,
      quantity: quantity.toFixed(6),
      cost: row.unitCost === null ? ('unknown' as const) : money(quantity.times(row.unitCost), currency),
    };
  });
};

const fetchWasteLines = async (
  dashboard: DashboardRepository,
  params: PeriodParams,
  currency: CurrencyCode
): Promise<ReasonCodedWasteLine[]> => {
  const waste = await dashboard.findWaste(params.storeId, params.from, params.to);
  return waste.map((row) => {
    const quantity = new Decimal(row.quantity).abs();
    return {
      reasonCode: row.reasonCode!,
      value: row.unitCost === null ? ('unknown' as const) : money(new Decimal(row.unitCost).times(quantity), currency),
    };
  });
};

/* ------------------------------------------------------------------ waste_percentage */

export const wastePercentageMetric = defineMetric<PeriodParams>({
  id: 'waste_percentage',
  description: 'Waste value as a percentage of cost of goods sold in the period.',
  parameters: periodParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'financial:read',
  sources: ['stock_movements'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const [wasteLines, consumptionLines] = await Promise.all([
      fetchWasteLines(dashboard, params, currency),
      fetchConsumptionLines(dashboard, params, currency),
    ]);
    const wasteValue = computeWasteBreakdown(wasteLines, currency).total;
    const cogs = computeCogsActual(consumptionLines, currency);
    const value = computeWastePercentage(wasteValue, cogs);
    const now = new Date();
    return {
      metricId: 'waste_percentage',
      value: value === 'unknown' ? 'unknown' : value.toFixed(2),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_movements', rowCount: wasteLines.length + consumptionLines.length }],
      ...(value === 'unknown' ? { unknownReason: 'Waste value or COGS is unknown, or COGS is zero.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ waste_by_reason (parameterized) */

export const wasteByReasonMetric = defineMetric<WasteReasonParams>({
  id: 'waste_by_reason',
  description: 'Waste value for a single reason code in the period (call once per reason code for a full breakdown).',
  parameters: wasteReasonParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['stock_movements'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const wasteLines = await fetchWasteLines(dashboard, params, currency);
    const value = computeWasteValueForReason(wasteLines, params.reasonCode, currency);
    const now = new Date();
    const matchingCount = wasteLines.filter((l) => l.reasonCode === params.reasonCode).length;
    return {
      metricId: 'waste_by_reason',
      value: value === 'unknown' ? 'unknown' : value.amount.toFixed(4),
      unit: 'CURRENCY',
      currency,
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_movements', rowCount: matchingCount }],
      ...(value === 'unknown'
        ? { unknownReason: `At least one '${params.reasonCode}' waste event had no known cost.` }
        : {}),
    };
  },
});

/* ------------------------------------------------------------------ expired_value */

export const expiredValueMetric = defineMetric<PeriodParams>({
  id: 'expired_value',
  description: 'Value of stock wasted specifically due to expiry in the period.',
  parameters: periodParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['stock_movements'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const wasteLines = await fetchWasteLines(dashboard, params, currency);
    const value = computeExpiredValue(wasteLines, currency);
    const now = new Date();
    const matchingCount = wasteLines.filter((l) => l.reasonCode === 'EXPIRED').length;
    return {
      metricId: 'expired_value',
      value: value === 'unknown' ? 'unknown' : value.amount.toFixed(4),
      unit: 'CURRENCY',
      currency,
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_movements', rowCount: matchingCount }],
      ...(value === 'unknown' ? { unknownReason: 'At least one EXPIRED waste event had no known cost.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ shrinkage_value / shrinkage_percentage */

const fetchVarianceLines = async (
  stockCounts: StockCountService,
  params: PeriodParams
): Promise<VarianceLine[]> => {
  const rows = await stockCounts.findApprovedVarianceLines(params.storeId, params.from, params.to);
  return rows
    .filter((row): row is { varianceQuantity: string; varianceValue: string } => row.varianceValue !== null)
    .map((row) => ({ varianceValue: row.varianceValue }));
};

export const shrinkageValueMetric = defineMetric<PeriodParams>({
  id: 'shrinkage_value',
  description: 'Net value of inventory variance found by approved stock counts in the period.',
  parameters: periodParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['stock_count_lines', 'stock_counts'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const stockCounts = new StockCountService(ctx.db, ctx.organizationId);
    const varianceLines = await fetchVarianceLines(stockCounts, params);
    const value = computeShrinkageValue(varianceLines, currency);
    const now = new Date();
    return {
      metricId: 'shrinkage_value',
      value: value.amount.toFixed(4),
      unit: 'CURRENCY',
      currency,
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_count_lines', rowCount: varianceLines.length }],
    };
  },
});

export const shrinkagePercentageMetric = defineMetric<PeriodParams>({
  id: 'shrinkage_percentage',
  description: 'Shrinkage value as a percentage of cost of goods sold in the period.',
  parameters: periodParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'financial:read',
  sources: ['stock_count_lines', 'stock_movements'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const stockCounts = new StockCountService(ctx.db, ctx.organizationId);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const [varianceLines, consumptionLines] = await Promise.all([
      fetchVarianceLines(stockCounts, params),
      fetchConsumptionLines(dashboard, params, currency),
    ]);
    const shrinkageValue = computeShrinkageValue(varianceLines, currency);
    const cogs = computeCogsActual(consumptionLines, currency);
    const value = computeShrinkagePercentage(shrinkageValue, cogs);
    const now = new Date();
    return {
      metricId: 'shrinkage_percentage',
      value: value === 'unknown' ? 'unknown' : value.toFixed(2),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [
        { table: 'stock_count_lines', rowCount: varianceLines.length },
        { table: 'stock_movements', rowCount: consumptionLines.length },
      ],
      ...(value === 'unknown' ? { unknownReason: 'COGS is unknown for the period, or COGS is zero.' } : {}),
    };
  },
});
