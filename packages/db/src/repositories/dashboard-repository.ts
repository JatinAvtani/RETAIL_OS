import { alias } from 'drizzle-orm/pg-core';
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { menuItems, posItems, products, salesTransactionLines, salesTransactions, stockMovements } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

const originalSalesTransactions = alias(salesTransactions, 'original_sales_transactions');

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
          occurredAt: salesTransactions.occurredAt,
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

  /**
   * Per-menu-item quantity sold AND real quantity-weighted average realized unit price, over
   * completed, mapped sales lines in the period — the input `margin_attribution`'s `price_effect`
   * term needs. Deliberately the ACTUAL transacted price (`Σ line_total / Σ quantity`), never
   * `menu_items.price` (today's list price, with no historical version) — a customer's real paid
   * price differs from list price through per-line discounts, and `menu_items` has no effective-
   * dated history to reconstruct what the list price even was at an earlier period. Only MAPPED
   * items are returned, matching `findSoldMappedItems`'s own completeness convention.
   */
  async findSoldMappedItemLines(storeId: string, from: Date, to: Date) {
    const rows = await this.runScoped((db) =>
      db.execute<{ menu_item_id: string; quantity_sold: string; revenue: string }>(sql`
        SELECT pi.menu_item_id, SUM(stl.quantity) AS quantity_sold, SUM(stl.line_total) AS revenue
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
    return rows.map((row) => ({
      menuItemId: row.menu_item_id,
      quantitySold: row.quantity_sold,
      revenue: row.revenue,
    }));
  }

  /**
   * How many sold lines in the period came from a POS item nobody has mapped yet — the honesty
   * signal on the dashboard.
   *
   * `IGNORED` is deliberately NOT counted as unmapped. It is a real, recorded human decision
   * ("this line never needs a menu item" — a gift card, a service charge, a tip) via
   * `posItems.ignore`, which is a genuinely different fact from `UNMAPPED` ("nobody has looked at
   * this yet"). Counting it as a gap meant one gift-card sale forced `cost_variance` and
   * `food_cost_pct` to "unknown" permanently, since this count gates them all-or-nothing — the
   * honest signal became a permanently-stuck one, which is the opposite of what it exists for.
   * A truly `UNMAPPED` item still counts, so the real "we can't cost part of what sold" warning
   * survives intact.
   *
   * Note this counts LINES, not revenue: an ignored line's revenue still flows into revenue-side
   * figures, which is correct — a gift card really was sold, it just has no food cost.
   */
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
          AND pi.mapping_status IS DISTINCT FROM 'IGNORED'
          AND (pi.id IS NULL OR pi.mapping_status <> 'MAPPED' OR pi.menu_item_id IS NULL)
      `)
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Transaction HEADERS (not lines) for every status in the period — `gross_revenue`/
   * `discount_rate`/`refund_rate` all need `subtotal`/`discount`/`total`/`status` at the
   * transaction level, not summed line totals, since `sales_transactions`' own columns are the
   * vendor's authoritative figures (see this table's own header comment: recomputing them from
   * lines risks disagreeing with the vendor's receipt by a cent). Unlike `findSalesLines`, this
   * does NOT filter to `COMPLETED` only — `refund_rate` specifically needs `REFUNDED` rows counted
   * against the period's gross revenue, and `discount_rate`/`gross_revenue` are conventionally
   * computed over completed sales only, which the metric's own compute step decides, not this
   * fetch.
   */
  async findTransactions(storeId: string, from: Date, to: Date) {
    return this.runScoped((db) =>
      db
        .select({
          occurredAt: salesTransactions.occurredAt,
          subtotal: salesTransactions.subtotal,
          discount: salesTransactions.discount,
          tax: salesTransactions.tax,
          total: salesTransactions.total,
          currency: salesTransactions.currency,
          status: salesTransactions.status,
        })
        .from(salesTransactions)
        .where(
          and(
            eq(salesTransactions.organizationId, this.organizationId),
            eq(salesTransactions.storeId, storeId),
            gte(salesTransactions.occurredAt, from),
            lt(salesTransactions.occurredAt, to)
          )
        )
    );
  }

  /**
   * Sales lines for completed transactions, joined to the POS item's own name/category — the input
   * `sales_mix_percentage` needs to group revenue by item. Returns `itemId: null` for a line with
   * no `posItemId` at all (rare, but the schema allows it) rather than dropping the row, so total
   * mix-grouped revenue still reconciles against `net_revenue` for the same period.
   */
  async findSalesLinesWithItem(storeId: string, from: Date, to: Date) {
    return this.runScoped((db) =>
      db
        .select({
          lineTotal: salesTransactionLines.lineTotal,
          itemId: salesTransactionLines.posItemId,
          itemName: posItems.name,
          currency: salesTransactions.currency,
        })
        .from(salesTransactionLines)
        .innerJoin(salesTransactions, eq(salesTransactionLines.transactionId, salesTransactions.id))
        .leftJoin(posItems, eq(salesTransactionLines.posItemId, posItems.id))
        .where(
          and(
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

  /**
   * `sales_anomaly`'s real input (the design) — one row per real calendar day with
   * completed gross revenue in `[from, to)`, using the SAME `subtotal`-is-authoritative convention
   * `findTransactions` already established (never recomputed from lines). A day with zero completed
   * sales simply has no row — the anomaly detector's own decomposition only ever sees days that
   * genuinely occurred, never a fabricated zero-revenue day for a store that was closed or a period
   * with a real gap.
   */
  async findDailyGrossRevenue(storeId: string, from: Date, to: Date) {
    const rows = await this.runScoped((db) =>
      db.execute<{ revenue_date: string; total_subtotal: string }>(sql`
        SELECT
          occurred_at::date AS revenue_date,
          SUM(subtotal) AS total_subtotal
        FROM sales_transactions
        WHERE organization_id = ${this.organizationId}
          AND store_id = ${storeId}
          AND status = 'COMPLETED'
          AND occurred_at >= ${from.toISOString()}::timestamptz
          AND occurred_at < ${to.toISOString()}::timestamptz
        GROUP BY occurred_at::date
        ORDER BY occurred_at::date
      `)
    );
    return rows.map((row) => ({ date: row.revenue_date, totalSubtotal: row.total_subtotal }));
  }

  /**
   * `waste_spike`'s real input — one row per real calendar day with waste in `[from, to)`,
   * `quantity * unitCost` summed per day. A `WASTE` movement with a `null` unitCost (I7 — cost
   * unknown, never coerced to zero) is EXCLUDED from this specific day's total rather than treated
   * as zero-value waste, matching every other waste-value compute function's own established
   * unknown-cost handling (`computeWasteValueForReason`, `margin.ts`'s `computeWasteValue`) — a
   * day's total is a real sum of only the lines with a known cost, not silently understated by
   * folding an unknown into zero.
   */
  async findDailyWasteValue(storeId: string, from: Date, to: Date) {
    const rows = await this.runScoped((db) =>
      db.execute<{ waste_date: string; total_value: string }>(sql`
        SELECT
          occurred_at::date AS waste_date,
          SUM(ABS(quantity) * unit_cost) AS total_value
        FROM stock_movements
        WHERE organization_id = ${this.organizationId}
          AND store_id = ${storeId}
          AND movement_type = 'WASTE'
          AND unit_cost IS NOT NULL
          AND occurred_at >= ${from.toISOString()}::timestamptz
          AND occurred_at < ${to.toISOString()}::timestamptz
        GROUP BY occurred_at::date
        ORDER BY occurred_at::date
      `)
    );
    return rows.map((row) => ({ date: row.waste_date, totalValue: row.total_value }));
  }

  /**
   * `consumption_anomaly`'s real ACTUAL-COGS half — one row per real calendar day with
   * `SALE_CONSUMPTION` movement in `[from, to)`, `ABS(quantity) * unit_cost` summed. Confirmed with
   * the user: this signal compares actual vs. theoretical COGS in DOLLARS per day (reusing
   * `computeCogsActual`'s existing formula, applied once per day), not a raw ingredient quantity —
   * a genuine per-day theoretical QUANTITY series would need per-day recipe explosion across every
   * sold item, real N+1 risk this task deliberately avoids. A movement with a `null` unit_cost (I7)
   * is excluded from that day's sum, matching `findDailyWasteValue`'s identical convention above.
   */
  async findDailyConsumptionCost(storeId: string, from: Date, to: Date) {
    const rows = await this.runScoped((db) =>
      db.execute<{ consumption_date: string; total_cost: string }>(sql`
        SELECT
          occurred_at::date AS consumption_date,
          SUM(ABS(quantity) * unit_cost) AS total_cost
        FROM stock_movements
        WHERE organization_id = ${this.organizationId}
          AND store_id = ${storeId}
          AND movement_type = 'SALE_CONSUMPTION'
          AND unit_cost IS NOT NULL
          AND occurred_at >= ${from.toISOString()}::timestamptz
          AND occurred_at < ${to.toISOString()}::timestamptz
        GROUP BY occurred_at::date
        ORDER BY occurred_at::date
      `)
    );
    return rows.map((row) => ({ date: row.consumption_date, totalCost: row.total_cost }));
  }

  /**
   * `consumption_anomaly`'s real THEORETICAL-COGS half — the SAME day-grouped shape as
   * `findSoldMappedItems` above, with `occurred_at::date` added to the GROUP BY. Deliberately
   * returns raw per-day (`menuItemId`, `quantitySold`) pairs rather than a resolved dollar figure —
   * the caller resolves each DISTINCT menu item's unit recipe cost exactly ONCE for the whole window
   * (menu item costs rarely change mid-window) and reuses it across every day that item sold, rather
   * than calling the resolver once per day per item, which would multiply resolver calls by the
   * number of days in the window for no real benefit.
   */
  async findDailySoldMappedItems(storeId: string, from: Date, to: Date) {
    const rows = await this.runScoped((db) =>
      db.execute<{ sale_date: string; menu_item_id: string; quantity_sold: string }>(sql`
        SELECT
          st.occurred_at::date AS sale_date,
          pi.menu_item_id,
          SUM(stl.quantity) AS quantity_sold
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
        GROUP BY st.occurred_at::date, pi.menu_item_id
        ORDER BY st.occurred_at::date
      `)
    );
    return rows.map((row) => ({ date: row.sale_date, menuItemId: row.menu_item_id, quantitySold: row.quantity_sold }));
  }

  /**
   * `fact_daily_sales`'s real input — every real COMPLETED line for one store within an
   * ALREADY-RESOLVED `[from, to)` UTC window (the caller resolves this via
   * `resolveLocalDateRange` against the store's own timezone; this method does no timezone logic
   * itself, matching `packages/domain/src/time/store-time.ts`'s own "one place resolves store-local
   * time" discipline). `menuItemId`/`posItemCategory` are `null` for an unmapped POS item (I7 — the
   * absence of a mapping is not evidence the sale didn't happen), `channel` is `null` when the
   * vendor didn't report one. `transactionSubtotal`/`transactionDiscount` are the PARENT
   * transaction's own header totals, carried on every line — the caller needs them to prorate the
   * transaction-level discount across lines by revenue share (no per-line discount exists in this
   * schema).
   */
  async findSalesLinesForFactAggregation(storeId: string, from: Date, to: Date) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select({
          transactionId: salesTransactions.id,
          occurredAt: salesTransactions.occurredAt,
          channel: salesTransactions.channel,
          transactionSubtotal: salesTransactions.subtotal,
          transactionDiscount: salesTransactions.discount,
          currency: salesTransactions.currency,
          lineTotal: salesTransactionLines.lineTotal,
          quantity: salesTransactionLines.quantity,
          menuItemId: posItems.menuItemId,
          posItemCategory: posItems.category,
        })
        .from(salesTransactionLines)
        .innerJoin(salesTransactions, eq(salesTransactionLines.transactionId, salesTransactions.id))
        .leftJoin(posItems, eq(salesTransactionLines.posItemId, posItems.id))
        .where(
          scopedWhere(
            and(
              eq(salesTransactions.storeId, storeId),
              eq(salesTransactions.status, 'COMPLETED'),
              gte(salesTransactions.occurredAt, from),
              lt(salesTransactions.occurredAt, to)
            )
          )
        )
    );
  }

  /**
   * `fact_daily_sales`'s refund half — every real `REFUNDED` transaction whose ORIGINAL
   * (`refundOfId`-referenced) transaction occurred within the resolved local day, even if the
   * refund itself was recorded later (a refund processed the next calendar day still belongs to
   * the sale it reverses, for fact-table attribution purposes — matching this project's own
   * bi-temporal convention of attributing a correction back to the event it corrects, not the
   * moment it was recorded). Returns the refunded transaction's real `total` and its ORIGINAL
   * transaction's id, for the caller to prorate across that original transaction's own lines by
   * the same revenue-share method used for discounts.
   */
  async findRefundsForFactAggregation(storeId: string, from: Date, to: Date) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select({
          originalTransactionId: originalSalesTransactions.id,
          refundTotal: salesTransactions.total,
        })
        .from(salesTransactions)
        .innerJoin(originalSalesTransactions, eq(salesTransactions.refundOfId, originalSalesTransactions.id))
        .where(
          scopedWhere(
            and(
              eq(salesTransactions.storeId, storeId),
              eq(salesTransactions.status, 'REFUNDED'),
              // `scopedWhere` only ANDs the tenant predicate against `salesTransactions` (this
              // repository's own constructor table) — the ALIASED join side needs its own explicit
              // organization_id check, defense in depth against `refundOfId` (a plain FK to `id`,
              // with no same-org constraint enforced at the schema level) ever pointing cross-org.
              eq(originalSalesTransactions.organizationId, this.organizationId),
              gte(originalSalesTransactions.occurredAt, from),
              lt(originalSalesTransactions.occurredAt, to)
            )
          )
        )
    );
  }

  /**
   * `fact_daily_consumption`'s real ACTUAL-consumption input — the same real
   * `SALE_CONSUMPTION` movements `findConsumption` reads, but INCLUDING `variantId`, which
   * `findConsumption`'s existing callers (margin metrics) never needed since they aggregate to a
   * single period total, not a per-variant fact row. A new method rather than widening
   * `findConsumption` itself — that method's existing, already-tested consumers get exactly the
   * columns they've always gotten, no silent shape change.
   */
  async findConsumptionForFactAggregation(storeId: string, from: Date, to: Date) {
    // NOT `scopedWhere` — that closure is bound to THIS repository's own constructor table
    // (`salesTransactions`), and would AND a `salesTransactions.organization_id` predicate against
    // a query that never joins that table at all (a real `missing FROM-clause entry` error this
    // project has hit before). `stockMovements` is a different table than this repository's own
    // constructor table, so the tenant predicate is built by hand against it directly — matching
    // `findConsumption`'s own existing, identical, already-tested pattern one screen above.
    return this.runScoped((db) =>
      db
        .select({
          productId: stockMovements.productId,
          variantId: stockMovements.variantId,
          quantity: stockMovements.quantity,
          unitCost: stockMovements.unitCost,
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

  /**
   * `fact_waste`'s real input — real `WASTE` movements including `reasonCode` (NOT NULL
   * on every real `WASTE` row by database constraint — `findWaste`'s own existing doc comment),
   * which neither `findWaste` (period-range, not per-store-day) nor `findDailyWasteValue`
   * (day-bucketed but reason-blind, earlier work) carries in the shape this fact table's grain needs.
   */
  async findWasteForFactAggregation(storeId: string, from: Date, to: Date) {
    return this.runScoped((db) =>
      db
        .select({
          productId: stockMovements.productId,
          reasonCode: stockMovements.reasonCode,
          quantity: stockMovements.quantity,
          unitCost: stockMovements.unitCost,
        })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.organizationId, this.organizationId),
            eq(stockMovements.storeId, storeId),
            eq(stockMovements.movementType, 'WASTE'),
            gte(stockMovements.occurredAt, from),
            lt(stockMovements.occurredAt, to)
          )
        )
    );
  }

  /**
   * earlier work (drill-through) — every real completed sales line in the period, WITH its own row id and
   * the menu item name it's mapped to (nullable — an unmapped line still appears, `menuItemName:
   * null`, matching this dashboard's own established "surface the gap, don't hide it" completeness
   * convention). Backs `net_revenue`/`transaction_count`/`average_transaction_value`'s drill-through.
   * A dedicated method rather than widening `findSalesLines` — that method's existing metric-compute
   * callers keep the exact columns they've always gotten; this one exists purely to let a human find
   * the specific row behind a number, a genuinely different concern from computing the number itself.
   */
  async findSalesLinesForDrillThrough(storeId: string, from: Date, to: Date, limit = 50) {
    return this.runScoped((db) =>
      db
        .select({
          id: salesTransactionLines.id,
          transactionId: salesTransactions.id,
          occurredAt: salesTransactions.occurredAt,
          lineTotal: salesTransactionLines.lineTotal,
          quantity: salesTransactionLines.quantity,
          currency: salesTransactions.currency,
          menuItemName: menuItems.name,
        })
        .from(salesTransactionLines)
        .innerJoin(salesTransactions, eq(salesTransactionLines.transactionId, salesTransactions.id))
        .leftJoin(posItems, eq(salesTransactionLines.posItemId, posItems.id))
        .leftJoin(menuItems, eq(posItems.menuItemId, menuItems.id))
        .where(
          and(
            eq(salesTransactionLines.organizationId, this.organizationId),
            eq(salesTransactions.organizationId, this.organizationId),
            eq(salesTransactions.storeId, storeId),
            eq(salesTransactions.status, 'COMPLETED'),
            gte(salesTransactions.occurredAt, from),
            lt(salesTransactions.occurredAt, to)
          )
        )
        .orderBy(sql`${salesTransactions.occurredAt} DESC`)
        .limit(limit)
    );
  }

  /**
   * earlier work (drill-through) — real `SALE_CONSUMPTION` movements with their own row id and the
   * product's name, backing `cogs_actual`'s drill-through. `unitCost: null` rows are included, not
   * filtered out (I7) — a human drilling into "why is actual COGS lower than expected" needs to see
   * the unknown-cost rows too, not just the ones that happened to have a cost.
   */
  async findConsumptionForDrillThrough(storeId: string, from: Date, to: Date, limit = 50) {
    return this.runScoped((db) =>
      db
        .select({
          id: stockMovements.id,
          occurredAt: stockMovements.occurredAt,
          quantity: stockMovements.quantity,
          unitCost: stockMovements.unitCost,
          currency: stockMovements.currency,
          productName: products.name,
        })
        .from(stockMovements)
        .leftJoin(products, eq(stockMovements.productId, products.id))
        .where(
          and(
            eq(stockMovements.organizationId, this.organizationId),
            eq(stockMovements.storeId, storeId),
            eq(stockMovements.movementType, 'SALE_CONSUMPTION'),
            gte(stockMovements.occurredAt, from),
            lt(stockMovements.occurredAt, to)
          )
        )
        .orderBy(sql`${stockMovements.occurredAt} DESC`)
        .limit(limit)
    );
  }

  /**
   * earlier work (drill-through) — real `WASTE` movements with their own row id and the product's name,
   * backing `waste_value`'s drill-through (the total AND each reason-code breakdown row, filtered
   * client-side by `reasonCode` when a specific reason is expanded).
   */
  async findWasteForDrillThrough(storeId: string, from: Date, to: Date, limit = 50) {
    return this.runScoped((db) =>
      db
        .select({
          id: stockMovements.id,
          occurredAt: stockMovements.occurredAt,
          quantity: stockMovements.quantity,
          unitCost: stockMovements.unitCost,
          currency: stockMovements.currency,
          reasonCode: stockMovements.reasonCode,
          productName: products.name,
        })
        .from(stockMovements)
        .leftJoin(products, eq(stockMovements.productId, products.id))
        .where(
          and(
            eq(stockMovements.organizationId, this.organizationId),
            eq(stockMovements.storeId, storeId),
            eq(stockMovements.movementType, 'WASTE'),
            gte(stockMovements.occurredAt, from),
            lt(stockMovements.occurredAt, to)
          )
        )
        .orderBy(sql`${stockMovements.occurredAt} DESC`)
        .limit(limit)
    );
  }
}
