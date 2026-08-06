import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { salesTransactionLines, salesTransactions, stockMovements } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * The read layer behind the owner dashboard. Deliberately fetches ROWS and hands them to the
 * registered metric functions in `@retailos/metrics` — it never sums, divides, or derives a
 * business number itself. That separation is the whole point: one place computes each number, so
 * the dashboard and any future consumer cannot drift apart.
 *
 * Every method is period-bounded and store-scoped, on top of the usual organization scoping.
 */
export class DashboardRepository extends TenantScopedRepository<typeof salesTransactions> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, salesTransactions, organizationId);
  }

  /**
   * Sales line totals for completed transactions in the period. `REFUNDED`/`VOIDED` transactions
   * are excluded rather than netted here — the refund handling built into ingestion already
   * updates the transaction's own status, so counting only `COMPLETED` rows avoids double-counting
   * a reversal that was already applied upstream.
   */
  async findSalesLines(storeId: string, from: Date, to: Date) {
    return this.runScoped((db) =>
      db
        .select({
          lineTotal: salesTransactionLines.lineTotal,
          quantity: salesTransactionLines.quantity,
          posItemId: salesTransactionLines.posItemId,
          currency: salesTransactions.currency,
        })
        .from(salesTransactionLines)
        .innerJoin(salesTransactions, eq(salesTransactionLines.transactionId, salesTransactions.id))
        .where(
          and(
            // Built by hand against each table's own organization_id rather than reusing this
            // repository's scopedWhere, which is bound to `sales_transactions` alone and would
            // produce a predicate referencing a table this query joins rather than selects from.
            eq(salesTransactionLines.organizationId, this.organizationId),
            eq(salesTransactions.organizationId, this.organizationId),
            eq(salesTransactions.storeId, storeId),
            eq(salesTransactions.status, 'COMPLETED'),
            gte(salesTransactions.occurredAt, from),
            lt(salesTransactions.occurredAt, to)
          )
        )
    );
  }

  /** Distinct completed transactions in the period — the denominator for average transaction value. */
  async countTransactions(storeId: string, from: Date, to: Date): Promise<number> {
    const rows = await this.runScoped((db) =>
      db
        .select({ count: sql<string>`count(*)` })
        .from(salesTransactions)
        .where(
          and(
            eq(salesTransactions.organizationId, this.organizationId),
            eq(salesTransactions.storeId, storeId),
            eq(salesTransactions.status, 'COMPLETED'),
            gte(salesTransactions.occurredAt, from),
            lt(salesTransactions.occurredAt, to)
          )
        )
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Real consumption events with the cost of the lot each was actually drawn from. `unitCost` is
   * nullable in the ledger, and that null is meaningful — it must reach the metric function as an
   * unknown, not be filtered out or defaulted, or COGS would silently understate.
   *
   * Quantities on consumption movements are negative (stock leaving); the absolute value is what
   * was consumed.
   */
  async findConsumption(storeId: string, from: Date, to: Date) {
    return this.runScoped((db) =>
      db
        .select({
          productId: stockMovements.productId,
          quantity: stockMovements.quantity,
          unitCost: stockMovements.unitCost,
          currency: stockMovements.currency,
        })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.organizationId, this.organizationId),
            eq(stockMovements.storeId, storeId),
            eq(stockMovements.movementType, 'SALE_CONSUMPTION'),
            gte(stockMovements.occurredAt, from),
            lt(stockMovements.occurredAt, to)
          )
        )
    );
  }

  /** Waste events with their reason codes. Reason code is NOT NULL on WASTE rows by database constraint, which is what makes grouping reliable. */
  async findWaste(storeId: string, from: Date, to: Date) {
    return this.runScoped((db) =>
      db
        .select({
          productId: stockMovements.productId,
          quantity: stockMovements.quantity,
          unitCost: stockMovements.unitCost,
          currency: stockMovements.currency,
          reasonCode: stockMovements.reasonCode,
        })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.organizationId, this.organizationId),
            eq(stockMovements.storeId, storeId),
            eq(stockMovements.movementType, 'WASTE'),
            isNotNull(stockMovements.reasonCode),
            gte(stockMovements.occurredAt, from),
            lt(stockMovements.occurredAt, to)
          )
        )
    );
  }

  /**
   * Units sold per POS item in the period, joined to the menu item a human confirmed it maps to.
   * Only MAPPED items are returned — an unmapped POS item has no recipe, so it cannot contribute a
   * theoretical cost. The count of what's excluded is surfaced separately on the dashboard as a
   * completeness signal, so a partial figure is never presented as if it were whole.
   */
  async findSoldMappedItems(storeId: string, from: Date, to: Date) {
    const rows = await this.runScoped((db) =>
      db.execute<{ menu_item_id: string; quantity_sold: string }>(sql`
        SELECT pi.menu_item_id, SUM(stl.quantity) AS quantity_sold
        FROM sales_transaction_lines stl
        JOIN sales_transactions st ON st.id = stl.transaction_id
        JOIN pos_items pi ON pi.id = stl.pos_item_id
        WHERE stl.organization_id = ${this.organizationId}
          AND st.organization_id = ${this.organizationId}
          AND st.store_id = ${storeId}
          AND st.status = 'COMPLETED'
          AND st.occurred_at >= ${from.toISOString()}::timestamptz
          AND st.occurred_at < ${to.toISOString()}::timestamptz
          AND pi.mapping_status = 'MAPPED'
          AND pi.menu_item_id IS NOT NULL
        GROUP BY pi.menu_item_id
      `)
    );
    return rows.map((row) => ({ menuItemId: row.menu_item_id, quantitySold: row.quantity_sold }));
  }

  /** How many sold lines in the period came from a POS item nobody has mapped yet — the honesty signal on the dashboard. */
  async countUnmappedSoldLines(storeId: string, from: Date, to: Date): Promise<number> {
    const rows = await this.runScoped((db) =>
      db.execute<{ count: string }>(sql`
        SELECT count(*) AS count
        FROM sales_transaction_lines stl
        JOIN sales_transactions st ON st.id = stl.transaction_id
        LEFT JOIN pos_items pi ON pi.id = stl.pos_item_id
        WHERE stl.organization_id = ${this.organizationId}
          AND st.organization_id = ${this.organizationId}
          AND st.store_id = ${storeId}
          AND st.status = 'COMPLETED'
          AND st.occurred_at >= ${from.toISOString()}::timestamptz
          AND st.occurred_at < ${to.toISOString()}::timestamptz
          AND (pi.id IS NULL OR pi.mapping_status <> 'MAPPED' OR pi.menu_item_id IS NULL)
      `)
    );
    return Number(rows[0]?.count ?? 0);
  }
}
