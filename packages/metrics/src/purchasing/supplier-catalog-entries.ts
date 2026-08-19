import { z } from 'zod';
import { GoodsReceiptRepository, SupplierPerformanceEventRepository, SupplierPriceRepository } from '@retailos/db';
import { defineMetric, type MetricContext, type MetricResult } from '../catalog/index.js';
import {
  computeFillRate,
  computeInvoiceAccuracy,
  computeOnTimeRate,
  computeQualityRejectRate,
  type SupplierPerformanceEventInput,
} from './supplier-performance.js';
import { computeLeadTimeActual, computeLeadTimeVariance, computePriceStabilityIndex } from './supplier-metrics.js';

/**
 * Supplier metrics registered into the catalog (the design, 7 of the 8 — `effective_unit_cost`
 * remains deliberately unbuilt, matching `supplier-performance.ts`'s own confirmed reasoning: no
 * delivery-fee/credit data exists anywhere in this codebase, and nothing has changed since that
 * was decided).
 *
 * `fill_rate`/`on_time_delivery_rate`/`invoice_accuracy_rate`/`quality_reject_rate` are thin
 * `defineMetric` wrappers around `supplier-performance.ts`'s existing, already-tested pure compute
 * functions — no new domain logic, just the catalog registration those functions never
 * got. `lead_time_actual`/`lead_time_variance`/`price_stability_index` are genuinely new metrics
 * with their own compute logic in `supplier-metrics.ts`, since no existing function/data source
 * covered them at the right grain.
 */

const supplierWindowParams = z.object({ supplierId: z.string().uuid(), from: z.coerce.date(), to: z.coerce.date() });
type SupplierWindowParams = z.infer<typeof supplierWindowParams>;

const supplierProductParams = z.object({ supplierProductId: z.string().uuid() });
type SupplierProductParams = z.infer<typeof supplierProductParams>;

const period = (params: { from: Date; to: Date }) => ({ from: params.from, to: params.to });

const fetchEvents = async (
  ctx: MetricContext,
  params: SupplierWindowParams
): Promise<SupplierPerformanceEventInput[]> => {
  const events = new SupplierPerformanceEventRepository(ctx.db, ctx.organizationId);
  const rows = await events.findForSupplierBetween(params.supplierId, params.from, params.to);
  return rows.map((row) => ({
    eventType: row.eventType,
    expectedValue: row.expectedValue,
    actualValue: row.actualValue,
    variance: row.variance,
  }));
};

const serializeRate = (value: number | null): string | 'unknown' =>
  value === null ? 'unknown' : (value * 100).toFixed(2);

/* ------------------------------------------------------------------ fill_rate */

export const fillRateMetric = defineMetric<SupplierWindowParams>({
  id: 'fill_rate',
  description: 'Percentage of ordered quantity actually received from a supplier in the period.',
  parameters: supplierWindowParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'purchasing:read',
  sources: ['supplier_performance_events'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const events = await fetchEvents(ctx, params);
    const value = computeFillRate(events);
    const now = new Date();
    return {
      metricId: 'fill_rate',
      value: serializeRate(value),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'supplier_performance_events', rowCount: events.length }],
      ...(value === null ? { unknownReason: 'No FILL_COMPLETE/FILL_SHORT events for this supplier in the period.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ on_time_delivery_rate */

export const onTimeDeliveryRateMetric = defineMetric<SupplierWindowParams>({
  id: 'on_time_delivery_rate',
  description: 'Percentage of deliveries from a supplier that arrived on time in the period.',
  parameters: supplierWindowParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'purchasing:read',
  sources: ['supplier_performance_events'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const events = await fetchEvents(ctx, params);
    const value = computeOnTimeRate(events);
    const now = new Date();
    return {
      metricId: 'on_time_delivery_rate',
      value: serializeRate(value),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'supplier_performance_events', rowCount: events.length }],
      ...(value === null ? { unknownReason: 'No DELIVERY_ON_TIME/DELIVERY_LATE events for this supplier in the period.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ invoice_accuracy_rate */

export const invoiceAccuracyRateMetric = defineMetric<SupplierWindowParams>({
  id: 'invoice_accuracy_rate',
  description: 'Percentage of invoices from a supplier that matched cleanly, with no variance, in the period.',
  parameters: supplierWindowParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'purchasing:read',
  sources: ['supplier_performance_events'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const events = await fetchEvents(ctx, params);
    const value = computeInvoiceAccuracy(events);
    const now = new Date();
    return {
      metricId: 'invoice_accuracy_rate',
      value: serializeRate(value),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'supplier_performance_events', rowCount: events.length }],
      ...(value === null ? { unknownReason: 'No INVOICE_CLEAN/INVOICE_ERROR events for this supplier in the period.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ quality_reject_rate */

export const qualityRejectRateMetric = defineMetric<SupplierWindowParams>({
  id: 'quality_reject_rate',
  description: 'Percentage of received quantity from a supplier rejected for quality reasons in the period.',
  parameters: supplierWindowParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'purchasing:read',
  sources: ['supplier_performance_events'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const events = await fetchEvents(ctx, params);
    const value = computeQualityRejectRate(events);
    const now = new Date();
    return {
      metricId: 'quality_reject_rate',
      value: serializeRate(value),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'supplier_performance_events', rowCount: events.length }],
      ...(value === null
        ? { unknownReason: 'No FILL_COMPLETE/FILL_SHORT events for this supplier in the period, so a received-quantity denominator cannot be determined.' }
        : {}),
    };
  },
});

/* ------------------------------------------------------------------ lead_time_actual / lead_time_variance */

export const leadTimeActualMetric = defineMetric<SupplierWindowParams>({
  id: 'lead_time_actual',
  description: 'Average days from a purchase order being sent to a supplier to the resulting receipt, in the period.',
  parameters: supplierWindowParams,
  unit: 'DAYS',
  requiredPermission: 'purchasing:read',
  sources: ['goods_receipts', 'purchase_orders'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const goodsReceipts = new GoodsReceiptRepository(ctx.db, ctx.organizationId);
    const lines = await goodsReceipts.findSupplierLeadTimes(params.supplierId, params.from, params.to);
    const value = computeLeadTimeActual(lines);
    const now = new Date();
    return {
      metricId: 'lead_time_actual',
      value: value === 'unknown' ? 'unknown' : value.toFixed(2),
      unit: 'DAYS',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'goods_receipts', rowCount: lines.length }],
      ...(value === 'unknown' ? { unknownReason: 'No PO-linked receipts with a real sentAt for this supplier in the period.' } : {}),
    };
  },
});

export const leadTimeVarianceMetric = defineMetric<SupplierWindowParams>({
  id: 'lead_time_variance',
  description: 'Standard deviation of purchase order lead time (sent to received) for a supplier in the period.',
  parameters: supplierWindowParams,
  unit: 'DAYS',
  requiredPermission: 'purchasing:read',
  sources: ['goods_receipts', 'purchase_orders'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const goodsReceipts = new GoodsReceiptRepository(ctx.db, ctx.organizationId);
    const lines = await goodsReceipts.findSupplierLeadTimes(params.supplierId, params.from, params.to);
    const value = computeLeadTimeVariance(lines);
    const now = new Date();
    return {
      metricId: 'lead_time_variance',
      value: value === 'unknown' ? 'unknown' : value.toFixed(2),
      unit: 'DAYS',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'goods_receipts', rowCount: lines.length }],
      ...(value === 'unknown' ? { unknownReason: 'Fewer than 2 PO-linked receipts for this supplier in the period.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ price_stability_index */

export const priceStabilityIndexMetric = defineMetric<SupplierProductParams>({
  id: 'price_stability_index',
  description: 'Coefficient of variation of unit price over one supplier product\'s real effective-dated price history.',
  parameters: supplierProductParams,
  unit: 'RATIO',
  requiredPermission: 'purchasing:read',
  sources: ['supplier_prices'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const supplierPrices = new SupplierPriceRepository(ctx.db, ctx.organizationId);
    const history = await supplierPrices.findHistory(params.supplierProductId);
    const value = computePriceStabilityIndex(history.map((row) => ({ unitPrice: row.unitPrice })));
    const now = new Date();
    return {
      metricId: 'price_stability_index',
      value: value === 'unknown' ? 'unknown' : value.toFixed(4),
      unit: 'RATIO',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'supplier_prices', rowCount: history.length }],
      ...(value === 'unknown'
        ? { unknownReason: 'Fewer than 2 recorded prices for this supplier product, or the average price is zero.' }
        : {}),
    };
  },
});
