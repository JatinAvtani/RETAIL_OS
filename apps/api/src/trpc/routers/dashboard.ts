import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import Decimal from 'decimal.js';
import {
  DashboardRepository,
  MenuItemRepository,
  PosConnectionRepository,
  RecipeRepository,
  StoreRepository,
} from '@retailos/db';
import { canAccessStore, type AuthContext, type Permission } from '@retailos/authz';
import { money } from '@retailos/domain';
import {
  computeWasteBreakdown,
  executeMetric,
  MetricPermissionDeniedError,
  type FoodCostPercentageTrendMetricResult,
  type ItemsByContributionMetricResult,
  type MarginMetricContext,
  type NetRevenueTrendMetricResult,
  type WasteLine,
} from '@retailos/metrics';
import { protectedProcedure, router } from '../trpc';
import { resolveRecipeUnitCost } from '../../metrics/recipe-cost-resolver';

/** `numeric > numeric` compares as strings otherwise — never string-compare a decimal figure. */
type TrendDirection = 'up' | 'down' | 'flat';
const numericDelta = (current: number | null, previous: number | null): TrendDirection | null => {
  if (current === null || previous === null) return null;
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
};

/**
 * Calls `executeMetric`, but a `MetricPermissionDeniedError` (the caller lacks that metric's
 * `requiredPermission`) becomes `null` instead of failing the WHOLE dashboard — confirmed with the
 * user: a manager with `financial:read` but not `inventory:read` should still see everything they
 * ARE entitled to, not get a hard 500 for the whole page because one panel needs a permission they
 * don't have. Any other error still propagates — this only degrades the specific, expected
 * "caller lacks this one permission" case.
 */
const tryMetric = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MetricPermissionDeniedError) return null;
    throw err;
  }
};

const summaryInput = z.object({
  storeId: z.string().uuid(),
  /** Trailing window in days. Kept explicit rather than defaulting silently, so the number on screen always states the period it covers. */
  days: z.number().int().min(1).max(365).default(30),
});

const numberOrNull = (value: string | 'unknown'): number | null =>
  value === 'unknown' ? null : Number(value);

const moneyOrNull = (value: string | 'unknown', currency: string) =>
  value === 'unknown' ? null : { amount: value, currency };

/**
 * The owner dashboard's read surface. Every figure it returns is resolved through
 * `executeMetric` — the catalog registered in `packages/metrics/src/catalog` (009-02) — rather
 * than computed inline. This is what makes "dashboard and AI produce identical values" (spec 12's
 * own acceptance criterion) true by construction: both call the same registered function, not two
 * independently-written code paths that happen to agree today.
 *
 * `resolveRecipeUnitCost` lives in `apps/api` (it throws `TRPCError`), so it's injected onto
 * `MarginMetricContext` here rather than imported into `packages/metrics` — see
 * `catalog-entries.ts`'s own header for why crossing that boundary the other way would be wrong.
 */
export const dashboardRouter = router({
  summary: protectedProcedure.input(summaryInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const to = new Date();
    const from = new Date(to.getTime() - input.days * 24 * 60 * 60 * 1000);
    const currency = 'USD' as const;

    const auth: AuthContext = {
      userId: ctx.session.userId,
      organizationId: ctx.session.organizationId,
      storeIds: ctx.session.storeIds,
      role: ctx.session.role,
      permissions: new Set(ctx.session.permissions as Permission[]),
    };
    const recipeRepository = new RecipeRepository(ctx.db, ctx.session.organizationId);
    const menuItemRepository = new MenuItemRepository(ctx.db, ctx.session.organizationId);

    const metricCtx: MarginMetricContext = {
      db: ctx.db,
      organizationId: ctx.session.organizationId,
      storeIds: ctx.session.storeIds,
      resolveRecipeUnitCost: async (_ctx, menuItemId, resolveCurrency) => {
        const menuItem = await menuItemRepository.findById(menuItemId);
        if (!menuItem) return 'unknown';
        // Per-UNIT cost, not per-batch — see resolveRecipeUnitCost for why the yield division
        // matters and how easily its absence hides.
        return resolveRecipeUnitCost(
          ctx.db,
          ctx.session.organizationId,
          recipeRepository,
          menuItem.recipeGroupId,
          resolveCurrency
        );
      },
    };

    const metricParams = { storeId: input.storeId, from, to };
    const dashboard = new DashboardRepository(ctx.db, ctx.session.organizationId);

    // The comparison period is the immediately preceding window of the SAME length — the same
    // period-over-period convention `supplierPerformance.trend` (008-15) already established for
    // this codebase, not a bucketed time series.
    const priorTo = from;
    const priorFrom = new Date(from.getTime() - input.days * 24 * 60 * 60 * 1000);
    const priorMetricParams = { storeId: input.storeId, from: priorFrom, to: priorTo };

    // 12 daily points for the top-row sparklines (dataviz figure contract: "12-point sparkline").
    const sparklinePeriods = Array.from({ length: 12 }, (_, i) => {
      const dayTo = new Date(to.getTime() - (11 - i) * (input.days * 24 * 60 * 60 * 1000) / 12);
      const dayFrom = new Date(dayTo.getTime() - (input.days * 24 * 60 * 60 * 1000) / 12);
      return { label: dayFrom.toISOString().slice(0, 10), from: dayFrom, to: dayTo };
    });

    const [
      netRevenue,
      transactionCount,
      cogsActual,
      cogsTheoretical,
      costVariance,
      contributionMargin,
      foodCostPercentage,
      contributionMarginPercentage,
      salesLines,
      waste,
      consumption,
      unmappedSoldLines,
      stockValue,
      priorNetRevenue,
      priorFoodCostPercentage,
      priorContributionMarginPercentage,
      netRevenueTrend,
      foodCostPercentageTrend,
      itemsByContribution,
    ] = await Promise.all([
      executeMetric('net_revenue', metricParams, auth, metricCtx),
      dashboard.countTransactions(input.storeId, from, to),
      executeMetric('cogs_actual', metricParams, auth, metricCtx),
      executeMetric('cogs_theoretical', metricParams, auth, metricCtx),
      executeMetric('cost_variance', metricParams, auth, metricCtx),
      executeMetric('contribution_margin', metricParams, auth, metricCtx),
      executeMetric('food_cost_percentage', metricParams, auth, metricCtx),
      executeMetric('contribution_margin_percentage', metricParams, auth, metricCtx),
      dashboard.findSalesLines(input.storeId, from, to),
      dashboard.findWaste(input.storeId, from, to),
      dashboard.findConsumption(input.storeId, from, to),
      dashboard.countUnmappedSoldLines(input.storeId, from, to),
      tryMetric(() => executeMetric('stock_value', { storeId: input.storeId }, auth, metricCtx)),
      executeMetric('net_revenue', priorMetricParams, auth, metricCtx),
      executeMetric('food_cost_percentage', priorMetricParams, auth, metricCtx),
      executeMetric('contribution_margin_percentage', priorMetricParams, auth, metricCtx),
      executeMetric('net_revenue_trend', { storeId: input.storeId, periods: sparklinePeriods }, auth, metricCtx) as Promise<NetRevenueTrendMetricResult>,
      executeMetric('food_cost_percentage_trend', { storeId: input.storeId, periods: sparklinePeriods }, auth, metricCtx) as Promise<FoodCostPercentageTrendMetricResult>,
      tryMetric(
        () => executeMetric('items_by_contribution', metricParams, auth, metricCtx) as Promise<ItemsByContributionMetricResult>
      ),
    ]);

    const unitsSold = salesLines
      .reduce((sum, line) => sum.plus(new Decimal(line.quantity)), new Decimal(0))
      .toFixed(6);
    const unknownCostConsumptionEvents = consumption.filter((row) => row.unitCost === null).length;

    // waste_value (the catalog metric) returns only a total; the per-reason breakdown isn't a
    // registered metric of its own yet, so it's computed inline via the same pure function the
    // catalog entry itself calls — never a second, independently-written aggregation.
    const wasteLines: WasteLine[] = waste.map((row) => {
      const quantity = new Decimal(row.quantity).abs();
      return {
        reasonCode: row.reasonCode!,
        value:
          row.unitCost === null
            ? ('unknown' as const)
            : money(new Decimal(row.unitCost).times(quantity), currency),
      };
    });
    const wasteBreakdown = computeWasteBreakdown(wasteLines, currency);

    /**
     * The exception feed (spec 12 §12.5's "same content as the daily briefing"). Confirmed with the
     * user: EPIC-010's AI narration doesn't exist yet, so this is the DETERMINISTIC HALF of spec 05
     * §5.7.4's own pipeline ("compute exception set" -> rank -> take top N) — every card here is a
     * plain fact from an already-registered metric, zero LLM prose. `tryMetric` degrades a
     * permission gap to "this exception type omitted," never a hard failure for the whole feed.
     * `cost_spike` (needs a specific `supplierProductId`) and `stockout_events` (needs a specific
     * `menuItemId`) are deliberately excluded from this first pass — both would need iterating every
     * confirmed supplier-product/menu-item to become store-wide, a real, larger fan-out than this
     * task's other additions; flagged as a known gap, not silently dropped.
     */
    const posConnectionRepository = new PosConnectionRepository(ctx.db, ctx.session.organizationId);
    const menuItemsForRecipeCheck = await menuItemRepository.findAll();

    const [
      documentsPendingReview,
      negativeStockIncidents,
      unmappedPosItemsCount,
      expiryRiskValue,
      menuItemsWithoutRecipe,
      stockProjectionDrift,
      salesAnomaly,
      wasteSpike,
      connections,
    ] = await Promise.all([
      tryMetric(() => executeMetric('documents_pending_review', { storeId: input.storeId }, auth, metricCtx)),
      tryMetric(() => executeMetric('negative_stock_incidents', { storeId: input.storeId }, auth, metricCtx)),
      tryMetric(() => executeMetric('unmapped_pos_items_count', { storeId: input.storeId }, auth, metricCtx)),
      tryMetric(() => executeMetric('expiry_risk_value', { storeId: input.storeId, horizonDays: 7 }, auth, metricCtx)),
      menuItemsForRecipeCheck.length > 0
        ? tryMetric(() => executeMetric('menu_items_without_recipe', {}, auth, metricCtx))
        : null,
      tryMetric(() => executeMetric('stock_projection_drift', {}, auth, metricCtx)),
      tryMetric(() => executeMetric('sales_anomaly', metricParams, auth, metricCtx)),
      tryMetric(() => executeMetric('waste_spike', metricParams, auth, metricCtx)),
      posConnectionRepository.findAllForOrganization(),
    ]);

    const dataFreshnessResults = await Promise.all(
      connections.map((c) => tryMetric(() => executeMetric('data_freshness_lag', { connectionId: c.id }, auth, metricCtx)))
    );

    type ExceptionCard = { id: string; severity: 'warning' | 'danger'; label: string };
    const exceptions: ExceptionCard[] = [];

    if (documentsPendingReview && documentsPendingReview.value !== 'unknown' && Number(documentsPendingReview.value) > 0) {
      exceptions.push({ id: 'documents_pending_review', severity: 'warning', label: `${documentsPendingReview.value} document(s) awaiting review` });
    }
    if (negativeStockIncidents && negativeStockIncidents.value !== 'unknown' && Number(negativeStockIncidents.value) > 0) {
      exceptions.push({ id: 'negative_stock_incidents', severity: 'danger', label: `${negativeStockIncidents.value} product(s) showing negative stock` });
    }
    if (unmappedPosItemsCount && unmappedPosItemsCount.value !== 'unknown' && Number(unmappedPosItemsCount.value) > 0) {
      exceptions.push({ id: 'unmapped_pos_items_count', severity: 'warning', label: `${unmappedPosItemsCount.value} POS item(s) still unmapped — consumption data is incomplete` });
    }
    if (expiryRiskValue && expiryRiskValue.value !== 'unknown' && new Decimal(expiryRiskValue.value).greaterThan(0)) {
      exceptions.push({ id: 'expiry_risk_value', severity: 'warning', label: `${money(expiryRiskValue.value, currency).amount.toFixed(2)} of stock expiring within 7 days` });
    }
    if (menuItemsWithoutRecipe && menuItemsWithoutRecipe.value !== 'unknown' && Number(menuItemsWithoutRecipe.value) > 0) {
      exceptions.push({ id: 'menu_items_without_recipe', severity: 'warning', label: `${menuItemsWithoutRecipe.value} menu item(s) with no linked recipe — margin is incomplete for these` });
    }
    if (stockProjectionDrift && stockProjectionDrift.value !== 'unknown' && Number(stockProjectionDrift.value) > 0) {
      exceptions.push({ id: 'stock_projection_drift', severity: 'danger', label: `${stockProjectionDrift.value} stock record(s) disagree with the ledger — a data-integrity bug` });
    }
    if (salesAnomaly && salesAnomaly.value !== 'unknown' && Number(salesAnomaly.value) > 0) {
      exceptions.push({ id: 'sales_anomaly', severity: 'warning', label: `${salesAnomaly.value} day(s) of unusual sales activity detected` });
    }
    if (wasteSpike && wasteSpike.value !== 'unknown' && Number(wasteSpike.value) > 0) {
      exceptions.push({ id: 'waste_spike', severity: 'warning', label: `${wasteSpike.value} day(s) of unusually high waste` });
    }
    for (const [i, lag] of dataFreshnessResults.entries()) {
      if (lag && lag.value !== 'unknown' && Number(lag.value) > 24 * 60) {
        exceptions.push({ id: `data_freshness_lag_${connections[i]!.id}`, severity: 'warning', label: `POS data for ${connections[i]!.vendor} hasn't synced in over a day` });
      }
    }

    return {
      period: { from: from.toISOString(), to: to.toISOString(), days: input.days },
      currency,
      netRevenue: moneyOrNull(netRevenue.value, currency),
      transactionCount,
      unitsSold,
      averageTransactionValue:
        transactionCount > 0 && netRevenue.value !== 'unknown'
          ? moneyOrNull(
              new Decimal(netRevenue.value).dividedBy(transactionCount).toFixed(4),
              currency
            )
          : null,
      cogsActual: moneyOrNull(cogsActual.value, currency),
      cogsTheoretical: moneyOrNull(cogsTheoretical.value, currency),
      costVariance: {
        value: moneyOrNull(costVariance.value, currency),
        direction:
          costVariance.value === 'unknown'
            ? 'unknown'
            : new Decimal(costVariance.value).isPositive() && !new Decimal(costVariance.value).isZero()
              ? 'over'
              : new Decimal(costVariance.value).isNegative()
                ? 'under'
                : 'exact',
      },
      contributionMargin: moneyOrNull(contributionMargin.value, currency),
      contributionMarginPercentage: numberOrNull(contributionMarginPercentage.value),
      foodCostPercentage: numberOrNull(foodCostPercentage.value),
      stockValue: stockValue ? moneyOrNull(stockValue.value, currency) : null,
      /**
       * Period-over-period deltas for the top-row stat tiles (spec 12 §12.5: "each with
       * period-over-period delta"). `direction: null` means no real comparison basis exists (either
       * period is unknown) — never a fabricated verdict, matching `supplierPerformance.trend`'s own
       * established convention (008-15). `stock_value` has no prior-period figure at all (it's
       * always "now" — no historical snapshot exists until 009-01's fact tables), so it has no delta.
       */
      deltas: {
        netRevenue: { direction: numericDelta(numberOrNull(netRevenue.value), numberOrNull(priorNetRevenue.value)) },
        // Higher food cost % is WORSE — direction alone doesn't say good/bad, the UI's own
        // higherIsBetter flag (per metric) decides tone, matching TrendBadge's contract.
        foodCostPercentage: { direction: numericDelta(numberOrNull(foodCostPercentage.value), numberOrNull(priorFoodCostPercentage.value)) },
        contributionMarginPercentage: {
          direction: numericDelta(numberOrNull(contributionMarginPercentage.value), numberOrNull(priorContributionMarginPercentage.value)),
        },
      },
      /** 12-point sparkline series for the top-row tiles that support one (dataviz figure contract). `stock_value` has none — see `deltas` comment. */
      trends: {
        netRevenue: netRevenueTrend.points.map((p) => p.value === 'unknown' ? null : Number(p.value)),
        foodCostPercentage: foodCostPercentageTrend.points.map((p) => (p.value === 'unknown' ? null : Number(p.value))),
      },
      /** The exception feed — see the assembly comment above for scope (deterministic only, no AI prose yet). */
      exceptions,
      /** Top/bottom menu items by real dollar contribution (spec 12 §12.5). `null` only when the caller lacks financial:read; a real empty `[]` when no items sold — these are different facts, never conflated. */
      itemsByContribution: itemsByContribution
        ? itemsByContribution.items.map((item) => ({
            menuItemId: item.menuItemId,
            menuItemName: item.menuItemName,
            totalContribution: item.totalContribution === 'unknown' ? null : moneyOrNull(item.totalContribution, currency),
          }))
        : null,
      waste: {
        total: moneyOrNull(wasteBreakdown.total === 'unknown' ? 'unknown' : wasteBreakdown.total.amount.toFixed(4), currency),
        byReason: wasteBreakdown.byReason.map((entry) => ({
          reasonCode: entry.reasonCode,
          value: entry.value.amount.toFixed(4),
        })),
        unknownCostEventCount: wasteBreakdown.unknownCostEventCount,
      },
      /**
       * Data-completeness signals. Surfaced deliberately rather than hidden: a theoretical COGS
       * computed over 60% of sales is not wrong, but presenting it without saying so would invite
       * the user to trust it as complete.
       */
      completeness: {
        unmappedSoldLines,
        unknownCostConsumptionEvents,
      },
    };
  }),
});
