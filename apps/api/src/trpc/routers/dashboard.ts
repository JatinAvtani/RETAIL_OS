import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import Decimal from 'decimal.js';
import {
  DashboardRepository,
  MenuItemRepository,
  StoreRepository,
  RecipeRepository,
} from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { money, type Money } from '@retailos/domain';
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
} from '@retailos/metrics';
import { protectedProcedure, router } from '../trpc';
import { resolveRecipeUnitCost } from '../../metrics/recipe-cost-resolver';

const summaryInput = z.object({
  storeId: z.string().uuid(),
  /** Trailing window in days. Kept explicit rather than defaulting silently, so the number on screen always states the period it covers. */
  days: z.number().int().min(1).max(365).default(30),
});

/** Serializes a Money (or 'unknown') for the wire. `Decimal` has no custom toJSON, so the amount is sent as an explicit string rather than relying on incidental serialization. */
const serializeMoney = (value: Money | 'unknown') =>
  value === 'unknown' ? null : { amount: value.amount.toFixed(4), currency: value.currency };

/**
 * The owner dashboard's read surface. Every figure it returns comes from a registered metric
 * function in `@retailos/metrics` — this router fetches rows, resolves recipe costs, and passes
 * them in. It performs no arithmetic on a business number itself, which is what keeps the
 * dashboard and any future consumer (an API, an assistant) mathematically identical by
 * construction rather than by discipline.
 *
 * Every value that can genuinely be unknown is serialized as `null` with an accompanying reason,
 * never as a zero. A dashboard that renders $0.00 for "we could not determine this" is the exact
 * failure mode the costing invariants exist to prevent.
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

    const dashboard = new DashboardRepository(ctx.db, ctx.session.organizationId);
    const [salesLines, transactionCount, consumption, waste, soldMapped, unmappedSoldLines] =
      await Promise.all([
        dashboard.findSalesLines(input.storeId, from, to),
        dashboard.countTransactions(input.storeId, from, to),
        dashboard.findConsumption(input.storeId, from, to),
        dashboard.findWaste(input.storeId, from, to),
        dashboard.findSoldMappedItems(input.storeId, from, to),
        dashboard.countUnmappedSoldLines(input.storeId, from, to),
      ]);

    /* -------------------------------------------------- revenue */

    const netRevenue = computeNetRevenue(
      salesLines.map((line) => money(line.lineTotal, currency)),
      currency
    );

    const unitsSold = salesLines
      .reduce((sum, line) => sum.plus(new Decimal(line.quantity)), new Decimal(0))
      .toFixed(6);

    /* -------------------------------------------------- actual COGS (from real lot costs) */

    const consumptionLines: ConsumptionLine[] = consumption.map((row) => {
      const quantity = new Decimal(row.quantity).abs();
      return {
        productId: row.productId,
        quantity: quantity.toFixed(6),
        // A null unit cost on the ledger row is a genuine unknown and is passed through as one —
        // never filtered out and never defaulted, either of which would understate COGS.
        cost:
          row.unitCost === null
            ? ('unknown' as const)
            : money(new Decimal(row.unitCost).times(quantity), currency),
      };
    });
    const cogsActual = computeCogsActual(consumptionLines, currency);

    /* -------------------------------------------------- theoretical COGS (from recipes) */

    const menuItemRepository = new MenuItemRepository(ctx.db, ctx.session.organizationId);
    const recipeRepository = new RecipeRepository(ctx.db, ctx.session.organizationId);

    const soldItemLines: SoldItemLine[] = [];
    for (const sold of soldMapped) {
      const menuItem = await menuItemRepository.findById(sold.menuItemId);
      if (!menuItem) {
        soldItemLines.push({
          menuItemId: sold.menuItemId,
          quantitySold: sold.quantitySold,
          unitRecipeCost: 'unknown',
        });
        continue;
      }
      // Per-UNIT cost, not per-batch — see resolveRecipeUnitCost for why the yield division
      // matters and how easily its absence hides.
      const unitRecipeCost = await resolveRecipeUnitCost(
        ctx.db,
        ctx.session.organizationId,
        recipeRepository,
        menuItem.recipeGroupId,
        currency
      );
      soldItemLines.push({
        menuItemId: sold.menuItemId,
        quantitySold: sold.quantitySold,
        unitRecipeCost,
      });
    }
    const cogsTheoretical = computeCogsTheoretical(soldItemLines, currency);

    /* -------------------------------------------------- derived metrics */

    const costVariance = computeCostVariance(cogsActual, cogsTheoretical);
    const contributionMargin = computeContributionMargin(netRevenue, cogsActual);
    const foodCostPercentage = computeFoodCostPercentage(cogsActual, netRevenue);
    const contributionMarginPercentage = computeContributionMarginPercentage(
      contributionMargin,
      netRevenue
    );

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
      netRevenue: serializeMoney(netRevenue),
      transactionCount,
      unitsSold,
      averageTransactionValue:
        transactionCount > 0
          ? serializeMoney(money(netRevenue.amount.dividedBy(transactionCount), currency))
          : null,
      cogsActual: serializeMoney(cogsActual),
      cogsTheoretical: serializeMoney(cogsTheoretical),
      costVariance: {
        value: serializeMoney(costVariance.variance),
        direction: costVariance.direction,
      },
      contributionMargin: serializeMoney(contributionMargin),
      contributionMarginPercentage:
        contributionMarginPercentage === 'unknown' ? null : contributionMarginPercentage,
      foodCostPercentage: foodCostPercentage === 'unknown' ? null : foodCostPercentage,
      waste: {
        total: serializeMoney(wasteBreakdown.total),
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
        unknownCostConsumptionEvents: consumptionLines.filter((l) => l.cost === 'unknown').length,
      },
    };
  }),
});
