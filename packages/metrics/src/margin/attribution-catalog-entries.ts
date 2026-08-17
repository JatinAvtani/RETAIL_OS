import { z } from 'zod';
import Decimal from 'decimal.js';
import { money, type CurrencyCode, type Money } from '@retailos/domain';
import { DashboardRepository, MenuItemRepository } from '@retailos/db';
import { defineMetric, resolveCurrency, type MetricResult } from '../catalog/index.js';
import { computeContributionMarginPercentage, computeCogsActual, computeContributionMargin, computeNetRevenue } from './margin.js';
import { computeMarginAttribution, computeMarginPerItem, computeTotalContribution, type AttributionItemPair } from './attribution.js';
import { requireMarginContext, type MarginMetricContext } from './catalog-entries.js';

/**
 * The remaining spec 12 §C metrics — `margin_per_item`, `total_contribution`, `margin_trend`,
 * `margin_attribution` (§12.3, the "why" engine). `contribution_margin`/`contribution_margin_pct`
 * were already registered in 009-02's `catalog-entries.ts`; `menu_engineering_class` is explicitly
 * V2 in the spec and is not built here.
 *
 * All four reuse `MarginMetricContext`'s injected `resolveRecipeUnitCost` — the same collaborator
 * `cogs_theoretical` already depends on — since every metric here needs a menu item's per-unit
 * recipe cost.
 */

const singleItemParams = z.object({
  storeId: z.string().uuid(),
  menuItemId: z.string().uuid(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});
type SingleItemParams = z.infer<typeof singleItemParams>;

/**
 * `resolveRecipeUnitCost` takes a `recipeGroupId`, not a `menuItemId` — a menu item is a distinct
 * entity from the recipe it links to (spec 07 §7.3), so every metric here resolves the menu item's
 * `recipeGroupId` first. A menu item that no longer exists (or was never linked to a real recipe)
 * yields `'unknown'` here, never a thrown error that would blank the whole metric.
 */
const resolveMenuItemUnitCost = async (
  ctx: MarginMetricContext,
  menuItemId: string,
  currency: CurrencyCode
): Promise<Money | 'unknown'> => {
  const menuItemRepository = new MenuItemRepository(ctx.db, ctx.organizationId);
  const menuItem = await menuItemRepository.findById(menuItemId);
  if (!menuItem) return 'unknown';
  return ctx.resolveRecipeUnitCost(ctx, menuItem.recipeGroupId, currency);
};

const resolveItemFigures = async (
  ctx: MarginMetricContext,
  storeId: string,
  menuItemId: string,
  from: Date,
  to: Date,
  currency: CurrencyCode
): Promise<{ avgUnitPrice: Money; unitCost: Money | 'unknown'; quantitySold: string } | null> => {
  const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
  const lines = await dashboard.findSoldMappedItemLines(storeId, from, to);
  const line = lines.find((l) => l.menuItemId === menuItemId);
  if (!line || new Decimal(line.quantitySold).isZero()) return null;

  const quantity = new Decimal(line.quantitySold);
  const avgUnitPrice = money(new Decimal(line.revenue).dividedBy(quantity), currency);
  const unitCost = await resolveMenuItemUnitCost(ctx, menuItemId, currency);
  return { avgUnitPrice, unitCost, quantitySold: line.quantitySold };
};

export const marginPerItemMetric = defineMetric<SingleItemParams>({
  id: 'margin_per_item',
  description: 'Per-unit selling price minus unit cost for one menu item — the menu-engineering input.',
  parameters: singleItemParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'pos_items', 'recipes'],
  async execute(params, rawCtx): Promise<MetricResult> {
    const ctx = requireMarginContext(rawCtx, 'margin_per_item');
    const currency = await resolveCurrency(ctx);
    const figures = await resolveItemFigures(ctx, params.storeId, params.menuItemId, params.from, params.to, currency);
    const now = new Date();
    if (!figures) {
      return {
        metricId: 'margin_per_item',
        value: 'unknown',
        unit: 'CURRENCY',
        period: { from: params.from, to: params.to },
        computedAt: now,
        freshness: now,
        provenance: [{ table: 'sales_transaction_lines', rowCount: 0 }],
        unknownReason: 'This menu item had no completed, mapped sales in the period.',
      };
    }
    const marginPerItem = computeMarginPerItem(figures.avgUnitPrice, figures.unitCost);
    return {
      metricId: 'margin_per_item',
      value: marginPerItem === 'unknown' ? 'unknown' : marginPerItem.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: params.from, to: params.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'sales_transaction_lines', rowCount: 1 }],
      ...(marginPerItem === 'unknown' ? { unknownReason: 'The linked recipe has no fully-resolvable unit cost.' } : {}),
    };
  },
});

export const totalContributionMetric = defineMetric<SingleItemParams>({
  id: 'total_contribution',
  description: 'Margin per item times units sold for one menu item — ranks items by real dollar impact, not just margin rate.',
  parameters: singleItemParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'pos_items', 'recipes'],
  async execute(params, rawCtx): Promise<MetricResult> {
    const ctx = requireMarginContext(rawCtx, 'total_contribution');
    const currency = await resolveCurrency(ctx);
    const figures = await resolveItemFigures(ctx, params.storeId, params.menuItemId, params.from, params.to, currency);
    const now = new Date();
    if (!figures) {
      return {
        metricId: 'total_contribution',
        value: 'unknown',
        unit: 'CURRENCY',
        period: { from: params.from, to: params.to },
        computedAt: now,
        freshness: now,
        provenance: [{ table: 'sales_transaction_lines', rowCount: 0 }],
        unknownReason: 'This menu item had no completed, mapped sales in the period.',
      };
    }
    const marginPerItem = computeMarginPerItem(figures.avgUnitPrice, figures.unitCost);
    const totalContribution = computeTotalContribution(marginPerItem, figures.quantitySold);
    return {
      metricId: 'total_contribution',
      value: totalContribution === 'unknown' ? 'unknown' : totalContribution.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: params.from, to: params.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'sales_transaction_lines', rowCount: 1 }],
      ...(totalContribution === 'unknown' ? { unknownReason: 'The linked recipe has no fully-resolvable unit cost.' } : {}),
    };
  },
});

const storeItemsParams = z.object({ storeId: z.string().uuid(), from: z.coerce.date(), to: z.coerce.date() });
type StoreItemsParams = z.infer<typeof storeItemsParams>;

export type ItemContributionRow = { menuItemId: string; menuItemName: string; totalContribution: string | 'unknown' };
export type ItemsByContributionMetricResult = MetricResult & { items: ItemContributionRow[] };

/**
 * `items_by_contribution` (spec 12 §12.5's owner-dashboard "top/bottom items by total
 * contribution") — genuinely new: `total_contribution` above only ever computes ONE menu item per
 * call, with no existing catalog entry ranking every item sold in a period. Reuses
 * `findSoldMappedItemLines` (already `margin_attribution`'s own source for "which menu items sold")
 * and `computeMarginPerItem`/`computeTotalContribution` (the exact same formulas
 * `total_contribution` calls) rather than a third, independently-written ranking calculation — one
 * formula, computed once per item here instead of requiring N separate `total_contribution` calls
 * from every caller that wants a ranked view.
 */
export const itemsByContributionMetric = defineMetric<StoreItemsParams>({
  id: 'items_by_contribution',
  description: 'Every menu item sold in the period, ranked by total dollar contribution — highest and lowest performers.',
  parameters: storeItemsParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'pos_items', 'recipes'],
  async execute(params, rawCtx): Promise<ItemsByContributionMetricResult> {
    const ctx = requireMarginContext(rawCtx, 'items_by_contribution');
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);
    const menuItemRepository = new MenuItemRepository(ctx.db, ctx.organizationId);
    const now = new Date();

    const lines = await dashboard.findSoldMappedItemLines(params.storeId, params.from, params.to);
    const items = await Promise.all(
      lines
        .filter((line) => !new Decimal(line.quantitySold).isZero())
        .map(async (line): Promise<ItemContributionRow> => {
          const menuItem = await menuItemRepository.findById(line.menuItemId);
          const quantity = new Decimal(line.quantitySold);
          const avgUnitPrice = money(new Decimal(line.revenue).dividedBy(quantity), currency);
          const unitCost = await resolveMenuItemUnitCost(ctx, line.menuItemId, currency);
          const marginPerItem = computeMarginPerItem(avgUnitPrice, unitCost);
          const totalContribution = computeTotalContribution(marginPerItem, line.quantitySold);
          return {
            menuItemId: line.menuItemId,
            menuItemName: menuItem?.name ?? 'Unknown item',
            totalContribution: totalContribution === 'unknown' ? 'unknown' : totalContribution.amount.toFixed(4),
          };
        })
    );

    items.sort((a, b) => {
      if (a.totalContribution === 'unknown') return 1;
      if (b.totalContribution === 'unknown') return -1;
      return new Decimal(b.totalContribution).comparedTo(new Decimal(a.totalContribution));
    });

    const knownTotal = items.reduce(
      (sum, item) => (item.totalContribution === 'unknown' ? sum : sum.plus(new Decimal(item.totalContribution))),
      new Decimal(0)
    );

    return {
      metricId: 'items_by_contribution',
      value: items.length === 0 ? 'unknown' : knownTotal.toFixed(4),
      unit: 'CURRENCY',
      period: { from: params.from, to: params.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'sales_transaction_lines', rowCount: items.length }],
      items,
      ...(items.length === 0 ? { unknownReason: 'No mapped menu items sold in the period.' } : {}),
    };
  },
});

const marginTrendParams = z.object({
  storeId: z.string().uuid(),
  /** Each period's own [from, to) boundary — the caller decides the window shape (daily/weekly/etc). */
  periods: z.array(z.object({ label: z.string(), from: z.coerce.date(), to: z.coerce.date() })).min(1),
});
type MarginTrendParams = z.infer<typeof marginTrendParams>;

export type MarginTrendMetricResult = MetricResult & {
  points: Array<{ periodLabel: string; contributionMarginPercentage: string | 'unknown' }>;
};

export const marginTrendMetric = defineMetric<MarginTrendParams>({
  id: 'margin_trend',
  description: 'Contribution margin percentage over a rolling series of periods.',
  parameters: marginTrendParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'stock_movements', 'recipes'],
  async execute(params, rawCtx): Promise<MarginTrendMetricResult> {
    const ctx = requireMarginContext(rawCtx, 'margin_trend');
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);

    const points = await Promise.all(
      params.periods.map(async (period) => {
        const [salesLines, consumption] = await Promise.all([
          dashboard.findSalesLines(params.storeId, period.from, period.to),
          dashboard.findConsumption(params.storeId, period.from, period.to),
        ]);
        const netRevenue = computeNetRevenue(
          salesLines.map((line) => money(line.lineTotal, currency)),
          currency
        );
        const cogsActual = computeCogsActual(
          consumption.map((row) => ({
            productId: row.productId,
            quantity: new Decimal(row.quantity).abs().toFixed(6),
            cost:
              row.unitCost === null
                ? ('unknown' as const)
                : money(new Decimal(row.unitCost).times(new Decimal(row.quantity).abs()), currency),
          })),
          currency
        );
        const contributionMargin = computeContributionMargin(netRevenue, cogsActual);
        const pct = computeContributionMarginPercentage(contributionMargin, netRevenue);
        return {
          periodLabel: period.label,
          contributionMarginPercentage: pct === 'unknown' ? ('unknown' as const) : pct.toFixed(2),
        };
      })
    );

    const now = new Date();
    const lastKnown = [...points].reverse().find((p) => p.contributionMarginPercentage !== 'unknown');
    return {
      metricId: 'margin_trend',
      value: lastKnown ? lastKnown.contributionMarginPercentage : 'unknown',
      unit: 'PERCENTAGE',
      period: { from: params.periods[0]!.from, to: params.periods[params.periods.length - 1]!.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'sales_transaction_lines', rowCount: points.length }],
      points,
      ...(!lastKnown ? { unknownReason: 'No period in the requested series has a computable contribution margin.' } : {}),
    };
  },
});

const marginAttributionParams = z.object({
  storeId: z.string().uuid(),
  basePeriod: z.object({ from: z.coerce.date(), to: z.coerce.date() }),
  comparisonPeriod: z.object({ from: z.coerce.date(), to: z.coerce.date() }),
});
type MarginAttributionParams = z.infer<typeof marginAttributionParams>;

export type MarginAttributionMetricResult = MetricResult & {
  priceEffect: string | 'unknown';
  costEffect: string | 'unknown';
  mixEffect: string | 'unknown';
  volumeEffect: string | 'unknown';
  excludedItemIds: string[];
};

/**
 * `margin_attribution` (spec 12 §12.3) — see `attribution.ts`'s own header for the full formula
 * and ADR-15 (docs/spec/18-engineering-decisions.md) for the deliberate, verified deviation from
 * the spec's literal `Q₀`-weighted `price_effect`/`cost_effect` terms.
 */
export const marginAttributionMetric = defineMetric<MarginAttributionParams>({
  id: 'margin_attribution',
  description: 'Decomposes the change in contribution margin between two periods into price, cost, mix, and volume effects.',
  parameters: marginAttributionParams,
  unit: 'CURRENCY',
  requiredPermission: 'financial:read',
  sources: ['sales_transaction_lines', 'pos_items', 'recipes'],
  async execute(params, rawCtx): Promise<MarginAttributionMetricResult> {
    const ctx = requireMarginContext(rawCtx, 'margin_attribution');
    const currency = await resolveCurrency(ctx);
    const dashboard = new DashboardRepository(ctx.db, ctx.organizationId);

    const [baseLines, comparisonLines] = await Promise.all([
      dashboard.findSoldMappedItemLines(params.storeId, params.basePeriod.from, params.basePeriod.to),
      dashboard.findSoldMappedItemLines(params.storeId, params.comparisonPeriod.from, params.comparisonPeriod.to),
    ]);

    const allMenuItemIds = new Set([...baseLines.map((l) => l.menuItemId), ...comparisonLines.map((l) => l.menuItemId)]);

    const items: AttributionItemPair[] = [];
    for (const menuItemId of allMenuItemIds) {
      const baseLine = baseLines.find((l) => l.menuItemId === menuItemId);
      const comparisonLine = comparisonLines.find((l) => l.menuItemId === menuItemId);
      const unitCost = await resolveMenuItemUnitCost(ctx, menuItemId, currency);

      const toFigure = (line: typeof baseLine) =>
        line && !new Decimal(line.quantitySold).isZero()
          ? {
              price: money(new Decimal(line.revenue).dividedBy(new Decimal(line.quantitySold)), currency),
              cost: unitCost,
              quantity: line.quantitySold,
            }
          : null;

      items.push({ menuItemId, base: toFigure(baseLine), comparison: toFigure(comparisonLine) });
    }

    const result = computeMarginAttribution(items, currency);
    const now = new Date();

    return {
      metricId: 'margin_attribution',
      value: result.totalChange === 'unknown' ? 'unknown' : result.totalChange.amount.toFixed(4),
      unit: 'CURRENCY',
      period: { from: params.basePeriod.from, to: params.comparisonPeriod.to },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'sales_transaction_lines', rowCount: baseLines.length + comparisonLines.length }],
      priceEffect: result.priceEffect === 'unknown' ? 'unknown' : result.priceEffect.amount.toFixed(4),
      costEffect: result.costEffect === 'unknown' ? 'unknown' : result.costEffect.amount.toFixed(4),
      mixEffect: result.mixEffect === 'unknown' ? 'unknown' : result.mixEffect.amount.toFixed(4),
      volumeEffect: result.volumeEffect === 'unknown' ? 'unknown' : result.volumeEffect.amount.toFixed(4),
      excludedItemIds: result.excludedItemIds,
      ...(result.totalChange === 'unknown'
        ? { unknownReason: 'No item had a resolvable cost in both periods to attribute a change over.' }
        : {}),
    };
  },
});
