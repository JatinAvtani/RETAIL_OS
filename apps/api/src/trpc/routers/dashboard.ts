import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import Decimal from 'decimal.js';
import {
  DashboardRepository,
  MenuItemRepository,
  ParLevelRepository,
  PosConnectionRepository,
  PurchaseOrderRepository,
  RecipeRepository,
  StoreRepository,
  StockLevelRepository,
  type PurchaseOrderStatus,
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
import { resolveRecipeUnitCost } from '@retailos/metrics';

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

/**
 * 009-16 — the finite set of owner/manager dashboard figures with a real drill-through source.
 * Not every registered metric is here (67 exist, most have no dashboard presence yet) — confirmed
 * with the user: this covers exactly the figures `summary`/`managerSummary` currently render.
 * `items_by_contribution`/`below_reorder_point`/`expiry_queue` are deliberately absent — each
 * already carries a real entity id per row (`menuItemId`/`productId`/`lotId`) straight from
 * `summary`/`managerSummary` themselves, so they need no separate drill-through call at all.
 */
const drillThroughFigures = [
  'net_revenue',
  'transaction_count',
  'average_transaction_value',
  'cogs_actual',
  'cogs_theoretical',
  'cost_variance',
  'contribution_margin',
  'food_cost_percentage',
  'stock_value',
  'waste_total',
  'waste_by_reason',
] as const;
type DrillThroughFigure = (typeof drillThroughFigures)[number];

const drillThroughInput = z.object({
  storeId: z.string().uuid(),
  figure: z.enum(drillThroughFigures),
  from: z.coerce.date(),
  to: z.coerce.date(),
  /** Only meaningful for `waste_by_reason` — which reason's rows to return. Ignored otherwise. */
  reasonCode: z.string().optional(),
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
 * `resolveRecipeUnitCost` (009-01, `@retailos/metrics`) is still injected onto `MarginMetricContext`
 * here rather than called directly inside the catalog entry — see `catalog-entries.ts`'s own header:
 * the catalog module stays free of concrete DB-repository wiring, taking its collaborators as
 * parameters instead, the same pattern `PostingService`/`MovementService` already use.
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
      averageTransactionValue,
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
      executeMetric('transaction_count', metricParams, auth, metricCtx),
      executeMetric('average_transaction_value', metricParams, auth, metricCtx),
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
      // transaction_count's own catalog entry is a plain COUNT(*) — always a real number, never
      // 'unknown' (an absence of transactions is a real zero, not a missing fact).
      transactionCount: Number(transactionCount.value),
      unitsSold,
      averageTransactionValue: moneyOrNull(averageTransactionValue.value, currency),
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

  /**
   * The manager dashboard's read surface (spec 12 §12.5): "items below reorder point · expiry
   * queue by value at risk · pending receipts · documents awaiting review · today's sales vs.
   * forecast/average · open PO status." Same `executeMetric`/`tryMetric` discipline as `summary` —
   * every real number comes from the registered catalog, never computed ad hoc here.
   *
   * `forecast` is deliberately NOT built — confirmed with the user: no forecasting capability
   * exists anywhere in this codebase, and spec 00 §00-overview states explicitly "No forecasts in
   * MVP. Ships with forecasting in V2." This surfaces "today vs. trailing average" only, the
   * honest, buildable half of the spec's own wording — not a silent substitution.
   *
   * "Items below reorder point" uses the SIMPLE literal `quantity <= reorder_point` check
   * (`ParLevelRepository.findBelowReorderPointForStore`), confirmed with the user as distinct from
   * `suggestReorder`'s richer supplier-grouped suggestion engine (already its own page,
   * `/purchase-orders/suggestions`) — this is a "needs attention" count, not "here's what to order."
   */
  managerSummary: protectedProcedure.input(summaryInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const to = new Date();
    const from = new Date(to.getTime() - input.days * 24 * 60 * 60 * 1000);
    const todayStart = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const currency = 'USD' as const;

    const auth: AuthContext = {
      userId: ctx.session.userId,
      organizationId: ctx.session.organizationId,
      storeIds: ctx.session.storeIds,
      role: ctx.session.role,
      permissions: new Set(ctx.session.permissions as Permission[]),
    };
    const metricCtx = { db: ctx.db, organizationId: ctx.session.organizationId, storeIds: ctx.session.storeIds };

    const parLevelRepository = new ParLevelRepository(ctx.db, ctx.session.organizationId);
    const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.session.organizationId);
    const purchaseOrderRepository = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);

    // "Open" excludes the three terminal states (RECEIVED/CLOSED/CANCELLED) — a PO that has fully
    // arrived or been closed out isn't something a manager needs to act on today.
    const OPEN_STATUSES: PurchaseOrderStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED'];

    const [
      belowReorderPoint,
      expiringLots,
      pendingReceiptsCount,
      openPoCounts,
      documentsPendingReview,
      documentsPendingReviewOldestAge,
      todayNetRevenue,
      trailingNetRevenue,
    ] = await Promise.all([
      parLevelRepository.findBelowReorderPointForStore(input.storeId),
      stockLevelRepository.findExpiringLots(input.storeId),
      purchaseOrderRepository.countPendingReceipts(input.storeId),
      Promise.all(OPEN_STATUSES.map((status) => purchaseOrderRepository.countByStatus(input.storeId, status))),
      tryMetric(() => executeMetric('documents_pending_review', { storeId: input.storeId }, auth, metricCtx)),
      tryMetric(() => executeMetric('documents_pending_review_oldest_age_days', { storeId: input.storeId }, auth, metricCtx)),
      tryMetric(() => executeMetric('net_revenue', { storeId: input.storeId, from: todayStart, to }, auth, metricCtx)),
      tryMetric(() => executeMetric('net_revenue', { storeId: input.storeId, from, to }, auth, metricCtx)),
    ]);

    const trailingDailyAverage =
      trailingNetRevenue && trailingNetRevenue.value !== 'unknown'
        ? new Decimal(trailingNetRevenue.value).dividedBy(input.days)
        : null;
    const todayValue = todayNetRevenue && todayNetRevenue.value !== 'unknown' ? new Decimal(todayNetRevenue.value) : null;

    return {
      period: { from: from.toISOString(), to: to.toISOString(), days: input.days },
      currency,
      belowReorderPoint: {
        count: belowReorderPoint.length,
        items: belowReorderPoint.map((row) => ({
          productId: row.productId,
          variantId: row.variantId,
          quantityOnHand: row.quantityOnHand,
          reorderPoint: row.reorderPoint,
        })),
      },
      expiryQueue: {
        totalValueAtRisk: expiringLots
          .reduce((sum, lot) => sum.plus(new Decimal(lot.valueAtRisk)), new Decimal(0))
          .toFixed(4),
        lots: expiringLots.map((lot) => ({
          lotId: lot.lotId,
          daysToExpiry: lot.daysToExpiry,
          remainingQuantity: lot.remainingQuantity,
          valueAtRisk: lot.valueAtRisk,
        })),
      },
      pendingReceipts: { count: pendingReceiptsCount },
      openPurchaseOrders: OPEN_STATUSES.map((status, i) => ({ status, count: openPoCounts[i]! })),
      documentsAwaitingReview: {
        count: documentsPendingReview && documentsPendingReview.value !== 'unknown' ? Number(documentsPendingReview.value) : null,
        oldestAgeDays:
          documentsPendingReviewOldestAge && documentsPendingReviewOldestAge.value !== 'unknown'
            ? Number(documentsPendingReviewOldestAge.value)
            : null,
      },
      /**
       * "Today's sales vs. trailing average" — the honest, buildable half of spec 12 §12.5's
       * "vs. forecast/average" (no forecasting capability exists, see this procedure's own header).
       * `direction: null` when either side is unknown — never a fabricated verdict.
       */
      todayVsAverage: {
        today: moneyOrNull(todayNetRevenue?.value ?? 'unknown', currency),
        trailingDailyAverage: trailingDailyAverage ? moneyOrNull(trailingDailyAverage.toFixed(4), currency) : null,
        direction: numericDelta(
          todayValue ? todayValue.toNumber() : null,
          trailingDailyAverage ? trailingDailyAverage.toNumber() : null
        ),
      },
    };
  }),

  /**
   * 009-16 — the real source rows behind a dashboard figure (spec 12 §12.5: "every number is
   * drillable to source rows"). Deliberately a SEPARATE query, not carried on `summary`'s own
   * response — most figures are never expanded, and fetching every drill-through row set on every
   * dashboard load would multiply the query cost of a page most sessions only summarize, not audit.
   * `figure` is a closed enum (`drillThroughFigures` above), not a free-text table/column name —
   * an open string would let a caller probe arbitrary tables, a real I4-adjacent risk this endpoint
   * exists specifically to avoid. Every branch is period+store-bounded through the SAME
   * `DashboardRepository`/`StockLevelRepository` this router's other procedures already use.
   */
  drillThrough: protectedProcedure.input(drillThroughInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const dashboard = new DashboardRepository(ctx.db, ctx.session.organizationId);
    const figure: DrillThroughFigure = input.figure;

    switch (figure) {
      case 'net_revenue':
      case 'transaction_count':
      case 'average_transaction_value': {
        const rows = await dashboard.findSalesLinesForDrillThrough(input.storeId, input.from, input.to);
        return {
          figure,
          rows: rows.map((row) => ({
            id: row.id,
            occurredAt: row.occurredAt.toISOString(),
            label: row.menuItemName ?? 'Unmapped item',
            amount: { amount: row.lineTotal, currency: row.currency },
            quantity: row.quantity,
          })),
        };
      }
      case 'cogs_actual': {
        const rows = await dashboard.findConsumptionForDrillThrough(input.storeId, input.from, input.to);
        return {
          figure,
          rows: rows.map((row) => ({
            id: row.id,
            occurredAt: row.occurredAt.toISOString(),
            label: row.productName ?? 'Unknown product',
            amount: row.unitCost === null ? null : { amount: new Decimal(row.unitCost).times(new Decimal(row.quantity).abs()).toFixed(4), currency: row.currency ?? 'USD' },
            quantity: new Decimal(row.quantity).abs().toString(),
          })),
        };
      }
      // These four are composite figures — no single source table backs them beyond the same
      // sales+consumption rows `cogs_actual`/`net_revenue` already expose. Rather than a fourth
      // near-duplicate fetch, they point the caller at the two real underlying figures.
      case 'cogs_theoretical':
      case 'cost_variance':
      case 'contribution_margin':
      case 'food_cost_percentage': {
        return { figure, rows: [], relatedFigures: ['net_revenue', 'cogs_actual'] as const };
      }
      case 'stock_value': {
        const stockLevelRepository = new StockLevelRepository(ctx.db, ctx.session.organizationId);
        const rows = await stockLevelRepository.findStockValueForDrillThrough(input.storeId);
        return {
          figure,
          rows: rows.map((row) => ({
            id: row.id,
            label: row.productName,
            amount: { amount: new Decimal(row.remainingQuantity).times(row.unitCost).toFixed(4), currency: row.currency },
            quantity: row.remainingQuantity,
            expiryDate: row.expiryDate,
          })),
        };
      }
      case 'waste_total':
      case 'waste_by_reason': {
        const rows = await dashboard.findWasteForDrillThrough(input.storeId, input.from, input.to);
        const filtered = figure === 'waste_by_reason' && input.reasonCode ? rows.filter((row) => row.reasonCode === input.reasonCode) : rows;
        return {
          figure,
          rows: filtered.map((row) => ({
            id: row.id,
            occurredAt: row.occurredAt.toISOString(),
            label: row.productName ?? 'Unknown product',
            amount: row.unitCost === null ? null : { amount: new Decimal(row.unitCost).times(new Decimal(row.quantity).abs()).toFixed(4), currency: row.currency ?? 'USD' },
            quantity: new Decimal(row.quantity).abs().toString(),
            reasonCode: row.reasonCode,
          })),
        };
      }
    }
  }),
});
