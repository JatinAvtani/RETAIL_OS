import type { createDb } from '../client';
import { generateId, resolveLocalDate, resolveLocalDateRange, type StoreTimezone } from '@retailos/domain';
import { DashboardRepository } from '../repositories/dashboard-repository';
import { StockLevelRepository } from '../repositories/stock-level-repository';
import { PurchaseOrderRepository } from '../repositories/purchase-order-repository';
import { FactTableWriter } from '../repositories/fact-table-writer';
import { computeFactDailySales } from './fact-daily-sales';
import { computeFactDailyConsumption, resolveTheoreticalCogsForDate, type RecipeUnitCostLookup } from './fact-daily-consumption';
import { computeFactPurchaseLines } from './fact-purchase-lines';
import { computeFactWaste } from './fact-waste';

type Db = ReturnType<typeof createDb>['db'];

/**
 * The real orchestration entry point — everything a scheduled job (or a future manual
 * rebuild/backfill call) needs to fully recompute ALL FIVE fact tables for ONE store's ONE
 * store-local calendar date, from real source rows, idempotently (delete-then-insert per table,
 * `FactTableWriter`'s own guarantee). Called once per store per day by the incremental job — see
 * `packages/queue`/`apps/worker`'s fact-aggregation processor for the real scheduling wrapper
 * around this same function; this function itself has zero BullMQ/Redis awareness, matching
 * `computeRecipeCost`-style layering (the callable core is testable and callable without any queue
 * infrastructure at all).
 *
 * `resolveRecipeUnitCost` is injected, not imported, even though its real implementation (earlier work,
 * `@retailos/metrics`) is now a normal sibling package: `packages/db` cannot depend on
 * `packages/metrics` (metrics reads FROM db, never the reverse — a real `pnpm boundaries`
 * violation the other way), so the caller (the fact-aggregation worker processor) resolves the real
 * function and passes it in, matching `MarginMetricContext`'s identical injection in
 * `packages/metrics` itself.
 */
export const aggregateFactTablesForDay = async (
  db: Db,
  organizationId: string,
  storeId: string,
  storeTimezone: StoreTimezone,
  localDate: string,
  resolveRecipeUnitCost: RecipeUnitCostLookup
): Promise<void> => {
  const { from, to } = resolveLocalDateRange(localDate, storeTimezone);
  const asOfEndOfDay = to;

  const dashboard = new DashboardRepository(db, organizationId);
  const stockLevelRepository = new StockLevelRepository(db, organizationId);
  const purchaseOrderRepository = new PurchaseOrderRepository(db, organizationId);
  const writer = new FactTableWriter(db, organizationId);

  // fact_daily_sales
  const [salesLines, refunds] = await Promise.all([
    dashboard.findSalesLinesForFactAggregation(storeId, from, to),
    dashboard.findRefundsForFactAggregation(storeId, from, to),
  ]);
  const salesRows = computeFactDailySales(localDate, salesLines, refunds, storeTimezone);
  await writer.writeFactDailySales(storeId, localDate, salesRows);

  // fact_daily_consumption
  const [consumptionRows, soldItems] = await Promise.all([
    dashboard.findConsumptionForFactAggregation(storeId, from, to),
    dashboard.findDailySoldMappedItems(storeId, from, to),
  ]);
  const theoreticalCogs = await resolveTheoreticalCogsForDate(soldItems, resolveRecipeUnitCost);
  const consumptionFactRows = computeFactDailyConsumption(localDate, consumptionRows, theoreticalCogs);
  await writer.writeFactDailyConsumption(storeId, localDate, consumptionFactRows);

  // fact_daily_stock_value — a real end-of-day snapshot, not a movement aggregate.
  const stockValueRows = await stockLevelRepository.findStockValueForFactAggregation(storeId, asOfEndOfDay);
  await writer.writeFactDailyStockValue(
    storeId,
    localDate,
    stockValueRows.map((row) => ({
      id: generateId(),
      date: localDate,
      productId: row.productId,
      variantId: row.variantId,
      qtyOnHand: row.qtyOnHand,
      value: row.value,
      lotsExpiring7d: row.lotsExpiring7d,
    }))
  );

  // fact_purchase_lines
  const purchaseLines = await purchaseOrderRepository.findLinesForFactAggregation(storeId, from, to);
  const purchaseLineRows = computeFactPurchaseLines(localDate, purchaseLines);
  await writer.writeFactPurchaseLines(storeId, localDate, purchaseLineRows);

  // fact_waste
  const wasteRows = await dashboard.findWasteForFactAggregation(storeId, from, to);
  const wasteFactRows = computeFactWaste(localDate, wasteRows);
  await writer.writeFactWaste(storeId, localDate, wasteFactRows);
};

/** `resolveLocalDate(new Date(), timezone)` minus one calendar day — "yesterday" in the store's own local time, the incremental job's real per-store target. */
export const resolveYesterdayLocalDate = (timezone: StoreTimezone, now: Date = new Date()): string => {
  const todayLocal = resolveLocalDate(now, timezone);
  const yesterdayGuess = new Date(`${todayLocal}T00:00:00Z`);
  yesterdayGuess.setUTCDate(yesterdayGuess.getUTCDate() - 1);
  return yesterdayGuess.toISOString().slice(0, 10);
};
