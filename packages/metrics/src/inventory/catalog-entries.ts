import { z } from 'zod';
import Decimal from 'decimal.js';
import { money } from '@retailos/domain';
import { DashboardRepository, MenuItemRepository, RecipeRepository, StockLevelRepository } from '@retailos/db';
import { defineMetric, resolveCurrency, type MetricContext, type MetricResult } from '../catalog/index.js';
import {
  computeDaysOfSupply,
  computeDeadStockValue,
  computeExpiryRiskValue,
  computeInventoryTurnover,
  computeNegativeStockIncidentCount,
  computeStockProjectionDriftCount,
  computeStockValueByCategory,
  computeStockoutEventCount,
  computeStockoutRevenueImpact,
  computeTotalStockValue,
  type DeadStockLine,
} from './inventory.js';
import { computeCogsActual, type ConsumptionLine } from '../margin/margin.js';

/**
 * Inventory metrics registered into the catalog (spec 12 §D, all 9). Every `execute` follows the
 * same fetch-then-compute split as every other catalog file: a repository method fetches
 * already-scoped rows, the pure `compute*` functions in `inventory.ts` do the arithmetic.
 *
 * `stock_value`'s category breakdown is NOT part of the returned `MetricResult` — that type is a
 * fixed contract shared by every metric in the catalog (spec 10 §10.3), and adding an ad-hoc field
 * here would break that guarantee for every consumer that pattern-matches on it. The category
 * breakdown is real, computed data, but until the catalog gains a documented way to carry
 * structured detail alongside a scalar `value`, only the store-wide total is exposed through this
 * metric; the per-category rows remain available directly from
 * `StockLevelRepository.findStockValueByCategory` for any caller that needs the breakdown.
 *
 * `stockout_events`/`stockout_revenue_impact` are scoped to MENU ITEMS, not raw products, and only
 * check DIRECT `PRODUCT`-type recipe components (no sub-recipe recursion) — both confirmed scope
 * decisions for this task, not spec deviations invented silently.
 */

const CONSUMPTION_LOOKBACK_DAYS = 30;

const storeParams = z.object({ storeId: z.string().uuid() });
type StoreParams = z.infer<typeof storeParams>;

const orgParams = z.object({});
type OrgParams = z.infer<typeof orgParams>;

const productParams = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
});
type ProductParams = z.infer<typeof productParams>;

/* ------------------------------------------------------------------ stock_on_hand */

export const stockOnHandMetric = defineMetric<ProductParams>({
  id: 'stock_on_hand',
  description: 'The current ledger-projected quantity on hand for one product and variant at a store.',
  parameters: productParams,
  unit: 'COUNT',
  requiredPermission: 'inventory:read',
  sources: ['stock_levels'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);
    const row = await stockLevelRepository.find(params.storeId, params.productId, params.variantId);
    const now = new Date();
    return {
      metricId: 'stock_on_hand',
      value: row ? row.quantity : '0.000000',
      unit: 'COUNT',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_levels', rowCount: row ? 1 : 0 }],
    };
  },
});

/* ------------------------------------------------------------------ stock_value */

export const stockValueMetric = defineMetric<StoreParams>({
  id: 'stock_value',
  description: 'Total value of on-hand stock (remaining quantity times lot cost) for a store — cash tied up.',
  parameters: storeParams,
  unit: 'CURRENCY',
  requiredPermission: 'inventory:read',
  sources: ['lots', 'products'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);
    const lines = await stockLevelRepository.findStockValueByCategory(params.storeId);
    const byCategory = computeStockValueByCategory(lines, currency);
    const total = computeTotalStockValue(byCategory, currency);
    const now = new Date();
    return {
      metricId: 'stock_value',
      value: total.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'lots', rowCount: lines.length }],
    };
  },
});

/* ------------------------------------------------------------------ days_of_supply */

export const daysOfSupplyMetric = defineMetric<ProductParams>({
  id: 'days_of_supply',
  description: 'Stock on hand divided by average daily consumption — drives reorder timing.',
  parameters: productParams,
  unit: 'DAYS',
  requiredPermission: 'inventory:read',
  sources: ['stock_levels', 'stock_movements'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);
    const [row, consumptionRows] = await Promise.all([
      stockLevelRepository.find(params.storeId, params.productId, params.variantId),
      stockLevelRepository.findAverageDailyConsumption(params.storeId, CONSUMPTION_LOOKBACK_DAYS),
    ]);
    const stockOnHand = row ? row.quantity : '0.000000';
    const consumption = consumptionRows.find(
      (c) => c.productId === params.productId && c.variantId === params.variantId
    );
    const value = computeDaysOfSupply(stockOnHand, consumption?.avgDailyConsumption ?? null);
    const now = new Date();
    return {
      metricId: 'days_of_supply',
      value,
      unit: 'DAYS',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [
        { table: 'stock_levels', rowCount: row ? 1 : 0 },
        { table: 'stock_movements', rowCount: consumption ? 1 : 0 },
      ],
      ...(value === 'unknown' ? { unknownReason: 'No SALE_CONSUMPTION history in the trailing 30 days.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ inventory_turnover */

const turnoverParams = z.object({ storeId: z.string().uuid(), from: z.coerce.date(), to: z.coerce.date() });
type TurnoverParams = z.infer<typeof turnoverParams>;

export const inventoryTurnoverMetric = defineMetric<TurnoverParams>({
  id: 'inventory_turnover',
  description:
    'Cost of goods sold in the period divided by average stock value, annualized — how efficiently stock converts to sales.',
  parameters: turnoverParams,
  unit: 'RATIO',
  requiredPermission: 'inventory:read',
  sources: ['stock_movements', 'lots'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);
    const [consumption, stockValueLines] = await Promise.all([
      dashboard.findConsumption(params.storeId, params.from, params.to),
      stockLevelRepository.findStockValueByCategory(params.storeId),
    ]);
    const consumptionLines: ConsumptionLine[] = consumption.map((row) => ({
      productId: row.productId,
      quantity: new Decimal(row.quantity).abs().toFixed(6),
      cost: row.unitCost === null ? ('unknown' as const) : money(row.unitCost, currency),
    }));
    const cogsPeriod = computeCogsActual(consumptionLines, currency);
    const byCategory = computeStockValueByCategory(stockValueLines, currency);
    // "avg stock value" over the period would need multiple snapshots (a fact-table concern, spec
    // 12 §12.6, not built yet — 009-01); the CURRENT stock value is used as the best available
    // proxy, matching this project's own precedent of live-query approximations ahead of the
    // fact-table phase.
    const currentStockValue = computeTotalStockValue(byCategory, currency);
    const periodDays = Math.max(1, Math.round((params.to.getTime() - params.from.getTime()) / (24 * 60 * 60 * 1000)));
    const value = computeInventoryTurnover(cogsPeriod, currentStockValue, periodDays);
    const now = new Date();
    return {
      metricId: 'inventory_turnover',
      value: value === 'unknown' ? 'unknown' : value.toFixed(2),
      unit: 'RATIO',
      period: { from: params.from, to: params.to },
      computedAt: now,
      freshness: now,
      provenance: [
        { table: 'stock_movements', rowCount: consumption.length },
        { table: 'lots', rowCount: stockValueLines.length },
      ],
      ...(value === 'unknown' ? { unknownReason: 'COGS is unknown for the period, or current stock value is zero.' } : {}),
    };
  },
});

/* ------------------------------------------------------------------ dead_stock_value */

const deadStockParams = z.object({ storeId: z.string().uuid(), thresholdDays: z.number().int().min(1).default(60) });
type DeadStockParams = z.infer<typeof deadStockParams>;

export const deadStockValueMetric = defineMetric<DeadStockParams>({
  id: 'dead_stock_value',
  description: 'Value of on-hand stock with zero movement in the trailing threshold window — a cash release opportunity.',
  parameters: deadStockParams,
  unit: 'CURRENCY',
  requiredPermission: 'inventory:read',
  sources: ['stock_levels'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);
    const rows = await stockLevelRepository.findDeadStock(params.storeId, params.thresholdDays);
    const lines: DeadStockLine[] = rows.map((row) => ({
      quantity: row.quantity,
      avgUnitCost: row.avgUnitCost === null ? ('unknown' as const) : money(row.avgUnitCost, currency),
    }));
    const result = computeDeadStockValue(lines, currency);
    const now = new Date();
    return {
      metricId: 'dead_stock_value',
      value: result.total === 'unknown' ? 'unknown' : result.total.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_levels', rowCount: rows.length }],
      ...(result.total === 'unknown'
        ? { unknownReason: `${result.unknownCostLineCount} of ${rows.length} dead-stock lines had no known average cost.` }
        : {}),
    };
  },
});

/* ------------------------------------------------------------------ expiry_risk_value */

const expiryRiskParams = z.object({ storeId: z.string().uuid(), horizonDays: z.number().int().min(1).default(7) });
type ExpiryRiskParams = z.infer<typeof expiryRiskParams>;

export const expiryRiskValueMetric = defineMetric<ExpiryRiskParams>({
  id: 'expiry_risk_value',
  description: 'Value of stock expiring within the horizon that consumption pace suggests will not be used in time.',
  parameters: expiryRiskParams,
  unit: 'CURRENCY',
  requiredPermission: 'inventory:read',
  sources: ['lots', 'stock_movements'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);
    const lots = await stockLevelRepository.findExpiringLots(params.storeId);
    const value = computeExpiryRiskValue(
      lots.map((lot) => ({ valueAtRisk: lot.valueAtRisk, daysToExpiry: lot.daysToExpiry })),
      params.horizonDays,
      currency
    );
    const now = new Date();
    return {
      metricId: 'expiry_risk_value',
      value: value.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'lots', rowCount: lots.length }],
    };
  },
});

/* ------------------------------------------------------------------ negative_stock_incidents */

export const negativeStockIncidentsMetric = defineMetric<StoreParams>({
  id: 'negative_stock_incidents',
  description: 'Count of product/variant combinations currently showing negative stock — a data-quality signal, not a business metric.',
  parameters: storeParams,
  unit: 'COUNT',
  requiredPermission: 'inventory:read',
  sources: ['stock_levels'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);
    const rows = await stockLevelRepository.findNegativeStockForStore(params.storeId);
    const count = computeNegativeStockIncidentCount(rows);
    const now = new Date();
    return {
      metricId: 'negative_stock_incidents',
      value: String(count),
      unit: 'COUNT',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_levels', rowCount: rows.length }],
    };
  },
});

/* ------------------------------------------------------------------ stockout_events / stockout_revenue_impact */

const menuItemStockoutParams = z.object({
  storeId: z.string().uuid(),
  menuItemId: z.string().uuid(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});
type MenuItemStockoutParams = z.infer<typeof menuItemStockoutParams>;

/**
 * Finds the distinct calendar days, within [from, to), where at least one of `menuItemId`'s
 * recipe's DIRECT product components (no sub-recipe recursion — confirmed scope, see this file's
 * own header) had a real ledger stockout day. A menu item requiring 3 ingredients is "stocked out"
 * on any day at least one of them was.
 */
const findMenuItemStockoutDays = async (
  ctx: MetricContext,
  storeId: string,
  menuItemId: string,
  from: Date,
  to: Date
): Promise<{ days: Set<string> }> => {
  const menuItemRepository = new MenuItemRepository(ctx.db, ctx.organizationId);
  const recipeRepository = new RecipeRepository(ctx.db, ctx.organizationId);
  const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);

  const menuItem = await menuItemRepository.findById(menuItemId);
  if (!menuItem) return { days: new Set() };

  const version = await recipeRepository.findVersionAsOf(menuItem.recipeGroupId, to);
  if (!version) return { days: new Set() };

  const components = await recipeRepository.findComponents(version.id);
  const productIds = new Set(
    components.filter((c) => c.componentType === 'PRODUCT' && c.productId).map((c) => c.productId as string)
  );
  if (productIds.size === 0) return { days: new Set() };

  const stockoutRows = await stockLevelRepository.findStockoutDays(storeId, from, to);
  const days = new Set<string>();
  for (const row of stockoutRows) {
    if (productIds.has(row.productId)) {
      days.add(row.stockoutDate);
    }
  }
  return { days };
};

export const stockoutEventsMetric = defineMetric<MenuItemStockoutParams>({
  id: 'stockout_events',
  description: 'Count of days a menu item could not be made because a required ingredient hit zero stock while demand existed.',
  parameters: menuItemStockoutParams,
  unit: 'COUNT',
  requiredPermission: 'inventory:read',
  sources: ['stock_movements', 'recipes', 'recipe_components'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const { days } = await findMenuItemStockoutDays(ctx, params.storeId, params.menuItemId, params.from, params.to);
    const count = computeStockoutEventCount([...days].map((d) => ({ productId: '', variantId: '', stockoutDate: d })));
    const now = new Date();
    return {
      metricId: 'stockout_events',
      value: String(count),
      unit: 'COUNT',
      period: { from: params.from, to: params.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_movements', rowCount: count }],
    };
  },
});

export const stockoutRevenueImpactMetric = defineMetric<MenuItemStockoutParams>({
  id: 'stockout_revenue_impact',
  description:
    'ESTIMATE — lost revenue from stockout days, using trailing average selling velocity. Labeled as an estimate, never presented as a measurement.',
  parameters: menuItemStockoutParams,
  unit: 'CURRENCY',
  requiredPermission: 'inventory:read',
  sources: ['stock_movements', 'sales_transaction_lines', 'recipes'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const { days } = await findMenuItemStockoutDays(ctx, params.storeId, params.menuItemId, params.from, params.to);

    const menuItemRepository = new MenuItemRepository(ctx.db, ctx.organizationId);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);

    const menuItem = await menuItemRepository.findById(params.menuItemId);
    const now = new Date();
    if (!menuItem) {
      return {
        metricId: 'stockout_revenue_impact',
        value: 'unknown',
        unit: 'CURRENCY',
        period: { from: params.from, to: params.to },
        computedAt: now,
        freshness: now,
        provenance: [{ table: 'recipes', rowCount: 0 }],
        unknownReason: `Menu item '${params.menuItemId}' not found.`,
      };
    }

    const soldLines = await dashboard.findSoldMappedItemLines(params.storeId, params.from, params.to);
    const soldLine = soldLines.find((l) => l.menuItemId === params.menuItemId);
    const avgUnitPrice =
      soldLine && !new Decimal(soldLine.quantitySold).isZero()
        ? money(new Decimal(soldLine.revenue).dividedBy(new Decimal(soldLine.quantitySold)), currency)
        : ('unknown' as const);

    // avg daily consumption is estimated from the SAME menu item's own real sold-quantity rate
    // over the requested period — the trailing average velocity spec 12 §D calls for.
    const periodDays = Math.max(1, Math.round((params.to.getTime() - params.from.getTime()) / (24 * 60 * 60 * 1000)));
    const avgDailyConsumption = soldLine ? new Decimal(soldLine.quantitySold).dividedBy(periodDays).toFixed(6) : null;

    const result = computeStockoutRevenueImpact({ stockoutDayCount: days.size, avgDailyConsumption, avgUnitPrice }, currency);

    return {
      metricId: 'stockout_revenue_impact',
      value: result.estimatedImpact === 'unknown' ? 'unknown' : result.estimatedImpact.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: params.from, to: params.to },
      computedAt: now,
      freshness: now,
      provenance: [
        { table: 'stock_movements', rowCount: days.size },
        { table: 'sales_transaction_lines', rowCount: soldLine ? 1 : 0 },
      ],
      ...(result.estimatedImpact === 'unknown'
        ? { unknownReason: 'No sales history for this menu item in the period, so a selling rate/price cannot be estimated.' }
        : {}),
    };
  },
});

/* ------------------------------------------------------------------ stock_projection_drift */

export const stockProjectionDriftMetric = defineMetric<OrgParams>({
  id: 'stock_projection_drift',
  description: 'Count of product/variant rows where the stock_levels projection disagrees with the stock_movements ledger sum — a bug detector, not a business number.',
  parameters: orgParams,
  unit: 'COUNT',
  requiredPermission: 'inventory:read',
  sources: ['stock_movements', 'stock_levels'],
  async execute(_params, ctx: MetricContext): Promise<MetricResult> {
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);
    const rows = await stockLevelRepository.findDriftForOrg();
    const count = computeStockProjectionDriftCount(rows);
    const now = new Date();
    return {
      metricId: 'stock_projection_drift',
      value: String(count),
      unit: 'COUNT',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_levels', rowCount: rows.length }],
    };
  },
});
