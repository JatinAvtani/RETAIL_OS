import { z } from 'zod';
import type { CurrencyCode, Money } from '@retailos/domain';
import { MenuItemRepository, StockLevelRepository, SupplierPriceRepository } from '@retailos/db';
import { defineMetric, resolveCurrency, type MetricContext, type MetricResult } from '../catalog/index.js';
import type { RecipeUnitCostResolver } from '../margin/catalog-entries.js';
import { resolveUnitCostLatest, resolveUnitCostWeightedAvg } from './cost.js';

/**
 * Cost metrics registered into the catalog — see `cost.ts`'s own header for why these 4 (of
 * spec 12 §B's 8) are the remaining scope after 009-02 already registered the other 4.
 *
 * `unit_cost_weighted_avg` and `unit_cost_latest` are plain `MetricContext` consumers (just `db`/
 * `organizationId`) — unlike `recipe_cost`/`menu_item_cost` below, they need no injected resolver.
 *
 * `recipe_cost`/`menu_item_cost` need the SAME real recipe-resolution machinery (recursive
 * explosion, per-ingredient supplier price lookup, unit conversion) that lives in
 * `apps/api/src/metrics/recipe-cost-resolver.ts` — too many repository dependencies for
 * `packages/metrics` to own cleanly, and it throws `TRPCError`, a tRPC-specific shape. Matching
 * `cogs_theoretical`'s own precedent (009-02), the resolver is injected onto a dedicated context
 * extension rather than imported across the layer boundary.
 */

export type RecipeCostBreakdownResolver = (
  ctx: MetricContext,
  recipeGroupId: string,
  currency: CurrencyCode
) => Promise<{ total: Money | 'unknown' }>;

/** `MetricContext` extended with the two recipe-resolution collaborators these two metrics need.
 * `RecipeUnitCostResolver` is imported from `margin/catalog-entries.ts` rather than redefined —
 * both `menu_item_cost` here and `cogs_theoretical` (009-02) need the exact same shape. */
export type CostMetricContext = MetricContext & {
  resolveRecipeCostBreakdown: RecipeCostBreakdownResolver;
  resolveRecipeUnitCost: RecipeUnitCostResolver;
};

const requireCostContext = (ctx: MetricContext, metricId: string): CostMetricContext => {
  const candidate = ctx as Partial<CostMetricContext>;
  if (typeof candidate.resolveRecipeCostBreakdown !== 'function' || typeof candidate.resolveRecipeUnitCost !== 'function') {
    throw new Error(
      `Metric '${metricId}' requires a CostMetricContext (with resolveRecipeCostBreakdown/resolveRecipeUnitCost) — plain MetricContext is insufficient.`
    );
  }
  return ctx as CostMetricContext;
};

const unitCostWeightedAvgParams = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
});
type UnitCostWeightedAvgParams = z.infer<typeof unitCostWeightedAvgParams>;

export const unitCostWeightedAvgMetric = defineMetric<UnitCostWeightedAvgParams>({
  id: 'unit_cost_weighted_avg',
  description: 'The weighted average cost of on-hand stock for one product and variant at a store — the valuation basis.',
  parameters: unitCostWeightedAvgParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['stock_levels'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const currency = await resolveCurrency(ctx);
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.organizationId);
    const row = await stockLevelRepository.find(params.storeId, params.productId, params.variantId);
    const value = resolveUnitCostWeightedAvg(row?.avgUnitCost ?? null, currency);
    const now = new Date();
    return {
      metricId: 'unit_cost_weighted_avg',
      value: value === 'unknown' ? 'unknown' : value.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: now, to: now }, // a point-in-time valuation, not a period aggregate — from === to signals "as of now"
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'stock_levels', rowCount: row ? 1 : 0 }],
      ...(value === 'unknown' ? { unknownReason: 'No stock movement has ever recorded a cost for this product/variant/store.' } : {}),
    };
  },
});

const unitCostLatestParams = z.object({
  supplierProductId: z.string().uuid(),
});
type UnitCostLatestParams = z.infer<typeof unitCostLatestParams>;

export const unitCostLatestMetric = defineMetric<UnitCostLatestParams>({
  id: 'unit_cost_latest',
  description: 'The most recent invoice unit price for one confirmed supplier-product mapping — used for reorder decisions.',
  parameters: unitCostLatestParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['supplier_prices'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const supplierPriceRepository = new SupplierPriceRepository(ctx.db, ctx.organizationId);
    const current = await supplierPriceRepository.findCurrent(params.supplierProductId);
    const value = resolveUnitCostLatest(
      current ? { unitPrice: current.unitPrice, currency: current.currency as CurrencyCode } : null
    );
    const now = new Date();
    return {
      metricId: 'unit_cost_latest',
      value: value === 'unknown' ? 'unknown' : value.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'supplier_prices', rowCount: current ? 1 : 0 }],
      ...(value === 'unknown' ? { unknownReason: 'No currently-effective price exists for this supplier-product mapping.' } : {}),
    };
  },
});

const recipeCostParams = z.object({
  recipeGroupId: z.string().uuid(),
});
type RecipeCostParams = z.infer<typeof recipeCostParams>;

export const recipeCostMetric = defineMetric<RecipeCostParams>({
  id: 'recipe_cost',
  description: 'The total cost of one batch of a recipe — sum of component quantity times unit cost, recursive through sub-recipes.',
  parameters: recipeCostParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['recipes', 'recipe_components', 'supplier_prices'],
  async execute(params, rawCtx): Promise<MetricResult> {
    const ctx = requireCostContext(rawCtx, 'recipe_cost');
    const currency = await resolveCurrency(ctx);
    const breakdown = await ctx.resolveRecipeCostBreakdown(ctx, params.recipeGroupId, currency);
    const now = new Date();
    return {
      metricId: 'recipe_cost',
      value: breakdown.total === 'unknown' ? 'unknown' : breakdown.total.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'recipes', rowCount: 1 }],
      ...(breakdown.total === 'unknown'
        ? { unknownReason: 'One or more ingredients had no fully-resolvable confirmed supplier price.' }
        : {}),
    };
  },
});

const menuItemCostParams = z.object({
  menuItemId: z.string().uuid(),
});
type MenuItemCostParams = z.infer<typeof menuItemCostParams>;

export const menuItemCostMetric = defineMetric<MenuItemCostParams>({
  id: 'menu_item_cost',
  description: 'The per-unit cost of the recipe linked to one menu item — its theoretical cost of goods.',
  parameters: menuItemCostParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['menu_items', 'recipes', 'recipe_components', 'supplier_prices'],
  async execute(params, rawCtx): Promise<MetricResult> {
    const ctx = requireCostContext(rawCtx, 'menu_item_cost');
    const currency = await resolveCurrency(ctx);
    const menuItemRepository = new MenuItemRepository(ctx.db, ctx.organizationId);
    const menuItem = await menuItemRepository.findById(params.menuItemId);
    const now = new Date();
    if (!menuItem) {
      return {
        metricId: 'menu_item_cost',
        value: 'unknown',
        unit: 'CURRENCY',
        period: { from: now, to: now },
        computedAt: now,
        freshness: now,
        provenance: [{ table: 'menu_items', rowCount: 0 }],
        unknownReason: `Menu item '${params.menuItemId}' not found.`,
      };
    }

    const unitCost = await ctx.resolveRecipeUnitCost(ctx, menuItem.recipeGroupId, currency);
    return {
      metricId: 'menu_item_cost',
      value: unitCost === 'unknown' ? 'unknown' : unitCost.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [
        { table: 'menu_items', rowCount: 1 },
        { table: 'recipes', rowCount: 1 },
      ],
      ...(unitCost === 'unknown'
        ? { unknownReason: 'The linked recipe has no fully-resolvable per-unit cost.' }
        : {}),
    };
  },
});
