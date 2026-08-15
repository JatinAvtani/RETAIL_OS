import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import Decimal from 'decimal.js';
import { DashboardRepository, MenuItemRepository, RecipeRepository, StoreRepository } from '@retailos/db';
import { canAccessStore, type AuthContext, type Permission } from '@retailos/authz';
import { money } from '@retailos/domain';
import {
  computeWasteBreakdown,
  executeMetric,
  type MarginMetricContext,
  type WasteLine,
} from '@retailos/metrics';
import { protectedProcedure, router } from '../trpc';
import { resolveRecipeUnitCost } from '../../metrics/recipe-cost-resolver';

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
