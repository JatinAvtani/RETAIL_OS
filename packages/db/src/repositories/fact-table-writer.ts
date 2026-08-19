import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { factDailySales, factDailyConsumption, factDailyStockValue, factPurchaseLines, factWaste } from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';
import type { FactDailySalesRow } from '../fact-aggregation/fact-daily-sales';
import type { FactDailyConsumptionRow } from '../fact-aggregation/fact-daily-consumption';
import type { FactPurchaseLineRow } from '../fact-aggregation/fact-purchase-lines';
import type { FactWasteRow } from '../fact-aggregation/fact-waste';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type FactDailyStockValueRow = {
  id: string;
  date: string;
  productId: string;
  variantId: string;
  qtyOnHand: string;
  value: string | null;
  lotsExpiring7d: number;
};

/**
 * The write side of every fact table — real, idempotent rebuild via DELETE-then-INSERT
 * within one transaction per (organization, store, date), confirmed with the user over an
 * expression-based `ON CONFLICT` upsert: this codebase's fact-table unique indexes use `COALESCE`
 * expressions (to make NULL grain columns comparable across rebuild runs), which Drizzle's
 * `onConflictDoUpdate` doesn't cleanly target — and delete-then-insert is arguably MORE correct for
 * "fully rebuildable from source" anyway: if a bug fix changes which grain rows should
 * exist for a day (e.g. a reclassified product), a real upsert matched on the OLD grain would leave
 * stale orphaned rows behind, while delete-then-insert naturally reflects the new, correct set.
 *
 * Every method here re-runs REPEATABLY for the same (org, store, date) with the exact same
 * real-world source data producing the exact same end state — the property a real regression test
 * (see `fact-table-writer.test.ts`) proves directly, not just asserts by convention.
 */
export class FactTableWriter {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('FactTableWriter constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  private async runScoped<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => withTenantContext(tx, this.organizationId, () => fn(tx)));
  }

  async writeFactDailySales(storeId: string, date: string, rows: FactDailySalesRow[]): Promise<void> {
    await this.runScoped(async (tx) => {
      await tx
        .delete(factDailySales)
        .where(and(eq(factDailySales.organizationId, this.organizationId), eq(factDailySales.storeId, storeId), eq(factDailySales.date, date)));
      if (rows.length === 0) return;
      await tx.insert(factDailySales).values(
        rows.map((row) => ({
          id: row.id,
          organizationId: this.organizationId,
          storeId,
          date: row.date,
          menuItemId: row.menuItemId,
          posItemCategory: row.posItemCategory,
          channel: row.channel,
          daypart: row.daypart,
          units: row.units,
          grossRevenue: row.grossRevenue,
          discounts: row.discounts,
          refunds: row.refunds,
          netRevenue: row.netRevenue,
          transactionCount: String(row.transactionCount),
        }))
      );
    });
  }

  async writeFactDailyConsumption(storeId: string, date: string, rows: FactDailyConsumptionRow[]): Promise<void> {
    await this.runScoped(async (tx) => {
      await tx
        .delete(factDailyConsumption)
        .where(
          and(eq(factDailyConsumption.organizationId, this.organizationId), eq(factDailyConsumption.storeId, storeId), eq(factDailyConsumption.date, date))
        );
      if (rows.length === 0) return;
      await tx.insert(factDailyConsumption).values(
        rows.map((row) => ({
          id: row.id,
          organizationId: this.organizationId,
          storeId,
          date: row.date,
          productId: row.productId,
          variantId: row.variantId,
          actualQty: row.actualQty,
          actualCogs: row.actualCogs,
          theoreticalCogs: row.theoreticalCogs,
        }))
      );
    });
  }

  async writeFactDailyStockValue(storeId: string, date: string, rows: FactDailyStockValueRow[]): Promise<void> {
    await this.runScoped(async (tx) => {
      await tx
        .delete(factDailyStockValue)
        .where(
          and(eq(factDailyStockValue.organizationId, this.organizationId), eq(factDailyStockValue.storeId, storeId), eq(factDailyStockValue.date, date))
        );
      if (rows.length === 0) return;
      await tx.insert(factDailyStockValue).values(
        rows.map((row) => ({
          id: row.id,
          organizationId: this.organizationId,
          storeId,
          date: row.date,
          productId: row.productId,
          variantId: row.variantId,
          qtyOnHand: row.qtyOnHand,
          value: row.value,
          lotsExpiring7d: String(row.lotsExpiring7d),
        }))
      );
    });
  }

  async writeFactPurchaseLines(storeId: string, date: string, rows: FactPurchaseLineRow[]): Promise<void> {
    await this.runScoped(async (tx) => {
      await tx
        .delete(factPurchaseLines)
        .where(
          and(eq(factPurchaseLines.organizationId, this.organizationId), eq(factPurchaseLines.storeId, storeId), eq(factPurchaseLines.date, date))
        );
      if (rows.length === 0) return;
      await tx.insert(factPurchaseLines).values(
        rows.map((row) => ({
          id: row.id,
          organizationId: this.organizationId,
          storeId,
          date: row.date,
          supplierId: row.supplierId,
          productId: row.productId,
          poId: row.poId,
          qty: row.qty,
          unitPrice: row.unitPrice,
          total: row.total,
        }))
      );
    });
  }

  async writeFactWaste(storeId: string, date: string, rows: FactWasteRow[]): Promise<void> {
    await this.runScoped(async (tx) => {
      await tx
        .delete(factWaste)
        .where(and(eq(factWaste.organizationId, this.organizationId), eq(factWaste.storeId, storeId), eq(factWaste.date, date)));
      if (rows.length === 0) return;
      await tx.insert(factWaste).values(
        rows.map((row) => ({
          id: row.id,
          organizationId: this.organizationId,
          storeId,
          date: row.date,
          productId: row.productId,
          reasonCode: row.reasonCode,
          qty: row.qty,
          value: row.value,
        }))
      );
    });
  }
}
