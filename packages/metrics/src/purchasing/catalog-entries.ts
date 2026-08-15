import { z } from 'zod';
import { money, type CurrencyCode } from '@retailos/domain';
import {
  GoodsReceiptRepository,
  PurchaseOrderRepository,
  InvoiceMatchRepository,
  SupplierPerformanceEventRepository,
} from '@retailos/db';
import { defineMetric, type MetricContext, type MetricResult } from '../catalog/index.js';
import {
  computeAverageOrderValue,
  computeEmergencyPurchaseRate,
  computeOrderFrequency,
  computePoCycleTime,
  computePriceChangeImpact,
  computePriceVarianceTotal,
  computeSpendByCategory,
  computeTotalSpend,
  type PriceChangeEvent,
} from './purchasing.js';

/**
 * Purchasing metrics registered into the catalog (spec 12 §F). Every `execute` follows the same
 * fetch-then-compute split as every other catalog file: a repository method fetches already-scoped
 * rows, the pure `compute*` functions in `purchasing.ts` do the arithmetic.
 *
 * `total_spend`/`spend_by_category` are scoped to purchase order lines whose parent PO's status is
 * `APPROVED` or later — confirmed with the user, since this codebase has no invoice-level
 * "approved" concept for spec 12 §F's literal "approved invoice totals" wording to map onto.
 * `spend_by_category` is parameterized by a single `categoryId` (one call per category), matching
 * this catalog's fixed one-scalar-per-call `MetricResult` contract — the same resolution 009-07
 * used for `waste_by_reason`, extended here to open-ended per-org category ids rather than a fixed
 * enum. `price_variance_total` is a genuinely new, quantity-weighted metric reading from
 * `invoice_match_lines` — deliberately distinct from `purchasing/supplier-performance.ts`'s
 * `computeTotalPriceVariance`, which is a different, narrower, already-confirmed metric.
 * `price_change_impact` reads the already-computed `variance` off the most recent real
 * `PRICE_CHANGE` supplier-performance event (008-14's `detectPriceChange`) rather than
 * recomputing the same `Δunit_price × trailing_12mo_qty` formula a second time (I2).
 */

const CURRENCY: CurrencyCode = 'USD';

const storeParams = z.object({ storeId: z.string().uuid(), from: z.coerce.date(), to: z.coerce.date() });
type StoreParams = z.infer<typeof storeParams>;

const supplierParams = z.object({ supplierId: z.string().uuid(), from: z.coerce.date(), to: z.coerce.date() });
type SupplierParams = z.infer<typeof supplierParams>;

const categorySpendParams = z.object({
  storeId: z.string().uuid(),
  categoryId: z.string().uuid(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});
type CategorySpendParams = z.infer<typeof categorySpendParams>;

const supplierProductParams = z.object({
  supplierId: z.string().uuid(),
  productId: z.string().uuid(),
  since: z.coerce.date(),
});
type SupplierProductParams = z.infer<typeof supplierProductParams>;

const period = (params: { from: Date; to: Date }) => ({ from: params.from, to: params.to });

/* ------------------------------------------------------------------ total_spend / spend_by_category */

export const totalSpendMetric = defineMetric<StoreParams>({
  id: 'total_spend',
  description: 'Total approved purchase order spend for a store in the period, across all suppliers and categories.',
  parameters: storeParams,
  unit: 'CURRENCY',
  requiredPermission: 'purchasing:read',
  sources: ['purchase_order_lines', 'purchase_orders'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const purchaseOrders = new PurchaseOrderRepository(ctx.db, ctx.organizationId);
    const lines = await purchaseOrders.findApprovedSpendLines(params.storeId, params.from, params.to);
    const byCategory = computeSpendByCategory(lines, CURRENCY);
    const total = computeTotalSpend(byCategory, CURRENCY);
    const now = new Date();
    return {
      metricId: 'total_spend',
      value: total.amount.toFixed(4),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'purchase_order_lines', rowCount: lines.length }],
    };
  },
});

export const spendByCategoryMetric = defineMetric<CategorySpendParams>({
  id: 'spend_by_category',
  description: 'Approved purchase order spend for a single product category, for a store in the period (call once per category for a full breakdown).',
  parameters: categorySpendParams,
  unit: 'CURRENCY',
  requiredPermission: 'purchasing:read',
  sources: ['purchase_order_lines', 'purchase_orders', 'products'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const purchaseOrders = new PurchaseOrderRepository(ctx.db, ctx.organizationId);
    const lines = await purchaseOrders.findApprovedSpendLines(params.storeId, params.from, params.to);
    const byCategory = computeSpendByCategory(lines, CURRENCY);
    const now = new Date();
    const match = byCategory.find((entry) => entry.categoryId === params.categoryId);
    const matchingCount = lines.filter((l) => l.categoryId === params.categoryId).length;
    return {
      metricId: 'spend_by_category',
      value: (match?.value ?? money(0, CURRENCY)).amount.toFixed(4),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'purchase_order_lines', rowCount: matchingCount }],
    };
  },
});

/* ------------------------------------------------------------------ price_change_impact */

export const priceChangeImpactMetric = defineMetric<SupplierProductParams>({
  id: 'price_change_impact',
  description: 'Projected annualized dollar impact of the most recent significant unit price change for one product from one supplier.',
  parameters: supplierProductParams,
  unit: 'CURRENCY',
  requiredPermission: 'purchasing:read',
  sources: ['supplier_performance_events'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const events = new SupplierPerformanceEventRepository(ctx.db, ctx.organizationId);
    const rows = await events.findForSupplierAndProductSince(params.supplierId, params.productId, params.since);
    const priceChangeEvents: PriceChangeEvent[] = rows
      .filter((row) => row.eventType === 'PRICE_CHANGE')
      .map((row) => ({ variance: row.variance, occurredAt: row.occurredAt }));
    const value = computePriceChangeImpact(priceChangeEvents, CURRENCY);
    const now = new Date();
    return {
      metricId: 'price_change_impact',
      value: value === 'unknown' ? 'unknown' : value.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: params.since, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'supplier_performance_events', rowCount: priceChangeEvents.length }],
      ...(value === 'unknown'
        ? { unknownReason: 'No significant PRICE_CHANGE event has been detected for this product/supplier, or it had no trailing purchase history to project against.' }
        : {}),
    };
  },
});

/* ------------------------------------------------------------------ price_variance_total */

export const priceVarianceTotalMetric = defineMetric<SupplierParams>({
  id: 'price_variance_total',
  description: 'Total dollar impact of billed-vs-ordered price differences for a supplier in the period.',
  parameters: supplierParams,
  unit: 'CURRENCY',
  requiredPermission: 'purchasing:read',
  sources: ['invoice_match_lines', 'invoice_matches'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const invoiceMatches = new InvoiceMatchRepository(ctx.db, ctx.organizationId);
    const lines = await invoiceMatches.findPriceVarianceLines(params.supplierId, params.from, params.to);
    const validLines = lines
      .filter((l): l is { priceVariance: string; invoiceQuantity: string } => l.priceVariance !== null && l.invoiceQuantity !== null);
    const value = computePriceVarianceTotal(validLines, CURRENCY);
    const now = new Date();
    return {
      metricId: 'price_variance_total',
      value: value.amount.toFixed(4),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'invoice_match_lines', rowCount: validLines.length }],
    };
  },
});

/* ------------------------------------------------------------------ po_cycle_time */

export const poCycleTimeMetric = defineMetric<StoreParams>({
  id: 'po_cycle_time',
  description: 'Average hours from purchase order creation to being sent to the supplier, for a store in the period.',
  parameters: storeParams,
  unit: 'DAYS',
  requiredPermission: 'purchasing:read',
  sources: ['purchase_orders'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const purchaseOrders = new PurchaseOrderRepository(ctx.db, ctx.organizationId);
    const lines = await purchaseOrders.findSentCycleTimes(params.storeId, params.from, params.to);
    const value = computePoCycleTime(lines);
    const now = new Date();
    return {
      metricId: 'po_cycle_time',
      value: value === 'unknown' ? 'unknown' : value.toFixed(2),
      unit: 'DAYS',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'purchase_orders', rowCount: lines.length }],
      ...(value === 'unknown' ? { unknownReason: 'No purchase orders were sent in this period.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ order_frequency / average_order_value */

export const orderFrequencyMetric = defineMetric<SupplierParams>({
  id: 'order_frequency',
  description: 'Count of purchase orders placed with a supplier in the period.',
  parameters: supplierParams,
  unit: 'COUNT',
  requiredPermission: 'purchasing:read',
  sources: ['purchase_orders'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const purchaseOrders = new PurchaseOrderRepository(ctx.db, ctx.organizationId);
    const summary = await purchaseOrders.findSupplierOrderSummary(params.supplierId, params.from, params.to);
    const value = computeOrderFrequency(summary.poCount);
    const now = new Date();
    return {
      metricId: 'order_frequency',
      value: String(value),
      unit: 'COUNT',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'purchase_orders', rowCount: summary.poCount }],
    };
  },
});

export const averageOrderValueMetric = defineMetric<SupplierParams>({
  id: 'average_order_value',
  description: 'Average purchase order value for a supplier in the period.',
  parameters: supplierParams,
  unit: 'CURRENCY',
  requiredPermission: 'purchasing:read',
  sources: ['purchase_orders', 'purchase_order_lines'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const purchaseOrders = new PurchaseOrderRepository(ctx.db, ctx.organizationId);
    const summary = await purchaseOrders.findSupplierOrderSummary(params.supplierId, params.from, params.to);
    const totalSpend = money(summary.totalSpend ?? 0, CURRENCY);
    const value = computeAverageOrderValue(totalSpend, summary.poCount, CURRENCY);
    const now = new Date();
    return {
      metricId: 'average_order_value',
      value: value === 'unknown' ? 'unknown' : value.amount.toFixed(4),
      unit: 'CURRENCY',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'purchase_orders', rowCount: summary.poCount }],
      ...(value === 'unknown' ? { unknownReason: 'No purchase orders were placed with this supplier in the period.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ emergency_purchase_rate */

export const emergencyPurchaseRateMetric = defineMetric<StoreParams>({
  id: 'emergency_purchase_rate',
  description: 'Percentage of goods receipts in the period that had no linked purchase order — a proxy for planning quality.',
  parameters: storeParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'purchasing:read',
  sources: ['goods_receipts'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const goodsReceipts = new GoodsReceiptRepository(ctx.db, ctx.organizationId);
    const rows = await goodsReceipts.findReceiptPoLinkage(params.storeId, params.from, params.to);
    const receiptsWithoutPo = rows.filter((r) => r.purchaseOrderId === null).length;
    const value = computeEmergencyPurchaseRate(receiptsWithoutPo, rows.length);
    const now = new Date();
    return {
      metricId: 'emergency_purchase_rate',
      value: value === 'unknown' ? 'unknown' : value.toFixed(2),
      unit: 'PERCENTAGE',
      period: period(params),
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'goods_receipts', rowCount: rows.length }],
      ...(value === 'unknown' ? { unknownReason: 'No goods receipts were recorded in this period.' } : {}),
    };
  },
});
