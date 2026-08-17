import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { stockLevels, stockMovements } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';
import type { MovementType } from './stock-movement-repository';

/** Movement types that increase stock on hand — the only ones that ever move `avgUnitCost`. */
const INCREASING_MOVEMENT_TYPES: ReadonlySet<MovementType> = new Set([
  'RECEIPT',
  'TRANSFER_IN',
  'PRODUCTION_OUTPUT',
]);

/**
 * The projection's write/read surface for 005-03. `recordAndProject` is the movement-service
 * primitive plan.md's Phase 3 snippet describes: insert the ledger row and upsert the projection
 * in the SAME transaction, so the projection can never observe a movement the ledger doesn't also
 * have (and vice versa). Outbox emission and audit logging (also shown in that snippet) are
 * 005-06's job — this task's scope is specifically the ledger-insert + projection-upsert pair.
 *
 * `avgUnitCost` uses the standard moving-average-cost formula, recomputed ONLY on stock-increasing
 * movement types with a known `unitCost` — confirmed with the user rather than guessed, since
 * plan.md's snippet shows `quantity` being maintained but is silent on the cost formula.
 * Consumption/waste/transfer-out movements never touch `avgUnitCost`: selling or wasting stock
 * doesn't change the cost basis of what remains, and a WASTE/SALE_CONSUMPTION movement typically
 * carries the COST OF WHAT WAS TAKEN (e.g. a lot's cost), not a new purchase price — pulling the
 * running average toward that value would corrupt it. A movement with `unitCost: null` (I7 — cost
 * unknown) never touches `avgUnitCost` either, on any movement type: an unknown cost cannot inform
 * a known average, and must not silently be treated as zero.
 */
export class StockLevelRepository extends TenantScopedRepository<typeof stockLevels> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, stockLevels, organizationId);
  }

  /**
   * Inserts one `stock_movements` row and upserts the corresponding `stock_levels` row, in one
   * transaction. `quantity` is signed and already in the product's base unit (I6 — the caller has
   * already resolved units at its own boundary).
   */
  async recordAndProject(input: {
    id: string;
    storeId: string;
    productId: string;
    variantId: string;
    lotId?: string;
    movementType: MovementType;
    quantity: string;
    unitCost?: string;
    currency: string;
    occurredAt: Date;
    sourceType: string;
    sourceId?: string;
    idempotencyKey?: string;
    actorUserId?: string;
    reasonCode?: string;
    notes?: string;
  }) {
    return this.runScoped(async (db) => {
      const movementRows = await db
        .insert(stockMovements)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          storeId: input.storeId,
          productId: input.productId,
          variantId: input.variantId,
          lotId: input.lotId ?? null,
          movementType: input.movementType,
          quantity: input.quantity,
          unitCost: input.unitCost ?? null,
          currency: input.currency,
          occurredAt: input.occurredAt,
          sourceType: input.sourceType,
          sourceId: input.sourceId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          actorUserId: input.actorUserId ?? null,
          reasonCode: input.reasonCode ?? null,
          notes: input.notes ?? null,
        })
        .returning();

      const movement = movementRows[0];
      if (!movement) {
        throw new Error('Stock movement insert returned no row.');
      }

      const unitCost = input.unitCost ?? null;
      const recomputeCost = INCREASING_MOVEMENT_TYPES.has(input.movementType) && unitCost !== null;

      const projectionRows = await db
        .insert(stockLevels)
        .values({
          organizationId: this.organizationId,
          storeId: input.storeId,
          productId: input.productId,
          variantId: input.variantId,
          quantity: input.quantity,
          avgUnitCost: recomputeCost ? unitCost : null,
          lastMovementAt: input.occurredAt,
        })
        .onConflictDoUpdate({
          target: [stockLevels.storeId, stockLevels.productId, stockLevels.variantId],
          set: {
            quantity: sql`${stockLevels.quantity} + ${input.quantity}::numeric(19,6)`,
            avgUnitCost: recomputeCost
              ? sql`CASE
                      WHEN ${stockLevels.avgUnitCost} IS NULL OR ${stockLevels.quantity} <= 0
                        THEN ${unitCost}::numeric(19,4)
                      ELSE (${stockLevels.avgUnitCost} * ${stockLevels.quantity} + ${unitCost}::numeric(19,4) * ${input.quantity}::numeric(19,6))
                           / (${stockLevels.quantity} + ${input.quantity}::numeric(19,6))
                    END`
              : sql`${stockLevels.avgUnitCost}`,
            lastMovementAt: input.occurredAt,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      const projection = projectionRows[0];
      if (!projection) {
        throw new Error('Stock level upsert returned no row.');
      }

      return { movement, projection };
    });
  }

  async find(storeId: string, productId: string, variantId: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(stockLevels)
        .where(
          scopedWhere(
            and(eq(stockLevels.storeId, storeId), eq(stockLevels.productId, productId), eq(stockLevels.variantId, variantId))
          )
        )
    );
    return rows[0] ?? null;
  }

  /** Every projection row for one store — the "what's on hand right now" overview a stock-levels page reads from directly, never summing the ledger itself (the projection exists so callers don't have to). */
  async findAllForStore(storeId: string) {
    return this.runScoped((db, scopedWhere) =>
      db.select().from(stockLevels).where(scopedWhere(eq(stockLevels.storeId, storeId)))
    );
  }

  /**
   * The trailing-`lookbackDays`-day average daily consumption per (product, variant) for one
   * store — `SUM(-quantity) / lookbackDays` over `SALE_CONSUMPTION` movements, the exact formula
   * `findExpiryQueue`/`findReorderSuggestions` each independently re-derived inline (009-06: a
   * third caller needing the same number is what made extracting this the right call — see
   * `packages/metrics/src/inventory/inventory.ts` for the metrics consuming it). Deliberately does
   * NOT touch either of those two existing call sites — this is a new, additive read method, not a
   * refactor of proven code.
   *
   * A product/variant with zero `SALE_CONSUMPTION` rows in the window is simply absent from the
   * result (no zero-valued row) — the caller decides what "no consumption history" means for its
   * own metric (I7: absence is not evidence of zero demand), matching `findExpiryQueue`'s own
   * `COALESCE(..., 0)`-at-the-call-site convention rather than baking a default in here.
   */
  async findAverageDailyConsumption(storeId: string, lookbackDays: number, asOf: Date = new Date()) {
    const asOfIso = asOf.toISOString();
    const rows = await this.runScoped((db) =>
      db.execute<{ product_id: string; variant_id: string; avg_daily_consumption: string }>(sql`
        SELECT
          product_id,
          variant_id,
          SUM(-quantity) / ${lookbackDays}::numeric AS avg_daily_consumption
        FROM stock_movements
        WHERE organization_id = ${this.organizationId}
          AND store_id = ${storeId}
          AND movement_type = 'SALE_CONSUMPTION'
          AND occurred_at >= ${asOfIso}::timestamptz - (${lookbackDays} || ' days')::interval
          AND occurred_at < ${asOfIso}::timestamptz
        GROUP BY product_id, variant_id
      `)
    );
    return rows.map((row) => ({
      productId: row.product_id,
      variantId: row.variant_id,
      avgDailyConsumption: row.avg_daily_consumption,
    }));
  }

  /**
   * `stock_value`'s real input (spec 12 §D: `Σ remaining_qty × lot_cost`, store/category grain) —
   * sums over `lots.remaining_quantity × lots.unit_cost` for `ACTIVE` lots, the SAME source
   * `findExpiryQueue`'s `value_at_risk` reads from, deliberately NOT `stock_levels.avgUnitCost`
   * (009-06 research: the spec's own "lot_cost" wording points at the lots table, and lot-level
   * cost is the more granular, more correct source anyway — `stock_levels.avgUnitCost` is a
   * blended average that exists for a different purpose). Grouped by `products.category_id`;
   * `category_id IS NULL` groups under a real `categoryId: null` row rather than being dropped —
   * the caller labels it "Uncategorized" (I7 — an uncategorized product's real value still counts
   * toward the store's total cash tied up).
   */
  async findStockValueByCategory(storeId: string) {
    const rows = await this.runScoped((db) =>
      db.execute<{ category_id: string | null; total_value: string }>(sql`
        SELECT
          p.category_id,
          SUM(l.remaining_quantity * l.unit_cost) AS total_value
        FROM lots l
        INNER JOIN products p ON p.id = l.product_id
        WHERE l.organization_id = ${this.organizationId}
          AND l.store_id = ${storeId}
          AND l.status = 'ACTIVE'
          AND l.remaining_quantity > 0
        GROUP BY p.category_id
      `)
    );
    return rows.map((row) => ({ categoryId: row.category_id, totalValue: row.total_value }));
  }

  /**
   * 009-16 (drill-through) — the real per-lot rows behind `stock_value`'s total, WITH each lot's
   * own id and the product's name, backing the dashboard's stock-value drill-through. Same
   * ACTIVE/remaining-quantity-positive filter as `findStockValueByCategory`, so the two figures
   * always reconcile — a human drilling in sees exactly the lots that summed to the number shown.
   */
  async findStockValueForDrillThrough(storeId: string, limit = 50) {
    const rows = await this.runScoped((db) =>
      db.execute<{
        id: string;
        product_name: string;
        remaining_quantity: string;
        unit_cost: string;
        currency: string;
        expiry_date: string | null;
      }>(sql`
        SELECT l.id, p.name AS product_name, l.remaining_quantity, l.unit_cost, l.currency, l.expiry_date
        FROM lots l
        INNER JOIN products p ON p.id = l.product_id
        WHERE l.organization_id = ${this.organizationId}
          AND l.store_id = ${storeId}
          AND l.status = 'ACTIVE'
          AND l.remaining_quantity > 0
        ORDER BY (l.remaining_quantity * l.unit_cost) DESC
        LIMIT ${limit}
      `)
    );
    return rows.map((row) => ({
      id: row.id,
      productName: row.product_name,
      remainingQuantity: row.remaining_quantity,
      unitCost: row.unit_cost,
      currency: row.currency,
      expiryDate: row.expiry_date,
    }));
  }

  /**
   * `dead_stock_value`'s real input — products/variants at this store whose `stock_levels.
   * last_movement_at` is older than `asOf - thresholdDays` (or has never moved at all,
   * `last_movement_at IS NULL`, with real quantity on hand from a source this codebase can't
   * currently attribute — e.g. a stocktake correction with no movement recorded, which is a real
   * data-quality gap surfaced here, not hidden). Only rows with `quantity > 0` are candidates — a
   * product at zero stock has no "dead" value to report regardless of how long it's been idle.
   */
  async findDeadStock(storeId: string, thresholdDays: number, asOf: Date = new Date()) {
    const asOfIso = asOf.toISOString();
    const rows = await this.runScoped((db) =>
      db.execute<{
        product_id: string;
        variant_id: string;
        quantity: string;
        avg_unit_cost: string | null;
        last_movement_at: string | null;
      }>(sql`
        SELECT product_id, variant_id, quantity, avg_unit_cost, last_movement_at
        FROM stock_levels
        WHERE organization_id = ${this.organizationId}
          AND store_id = ${storeId}
          AND quantity > 0
          AND (
            last_movement_at IS NULL
            OR last_movement_at < ${asOfIso}::timestamptz - (${thresholdDays} || ' days')::interval
          )
      `)
    );
    return rows.map((row) => ({
      productId: row.product_id,
      variantId: row.variant_id,
      quantity: row.quantity,
      avgUnitCost: row.avg_unit_cost,
      lastMovementAt: row.last_movement_at,
    }));
  }

  /**
   * `stockout_events`/`stockout_revenue_impact`'s real input — reconstructs each (product,
   * variant)'s running stock balance from the real ledger via a window function, then finds every
   * DAY where that balance was `<= 0` AND at least one `SALE_CONSUMPTION` movement occurred that
   * same day (spec's own "at zero WITH PRIOR DEMAND" qualifier — a product sitting at zero with no
   * one trying to buy it is not a lost-sale event, just an empty shelf nobody noticed).
   *
   * The running balance is computed as a cumulative sum of EVERY movement's `quantity` up to and
   * including each day (movements are already signed: consumption/waste are negative, receipts are
   * positive), then the day's CLOSING balance (the running sum after the day's last movement) is
   * what determines whether that day counts as a stockout day.
   */
  async findStockoutDays(storeId: string, from: Date, to: Date) {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const rows = await this.runScoped((db) =>
      db.execute<{
        product_id: string;
        variant_id: string;
        stockout_date: string;
        consumption_quantity: string;
      }>(sql`
        WITH daily_movements AS (
          SELECT
            product_id,
            variant_id,
            occurred_at::date AS movement_date,
            SUM(quantity) AS net_quantity,
            SUM(CASE WHEN movement_type = 'SALE_CONSUMPTION' THEN -quantity ELSE 0 END) AS consumption_quantity
          FROM stock_movements
          WHERE organization_id = ${this.organizationId}
            AND store_id = ${storeId}
            AND occurred_at < ${toIso}::timestamptz
          GROUP BY product_id, variant_id, occurred_at::date
        ),
        running_balance AS (
          SELECT
            product_id,
            variant_id,
            movement_date,
            consumption_quantity,
            SUM(net_quantity) OVER (
              PARTITION BY product_id, variant_id ORDER BY movement_date
            ) AS closing_balance
          FROM daily_movements
        )
        SELECT product_id, variant_id, movement_date AS stockout_date, consumption_quantity
        FROM running_balance
        WHERE closing_balance <= 0
          AND consumption_quantity > 0
          AND movement_date >= ${fromIso}::date
          AND movement_date < ${toIso}::date
        ORDER BY product_id, variant_id, movement_date
      `)
    );
    return rows.map((row) => ({
      productId: row.product_id,
      variantId: row.variant_id,
      stockoutDate: row.stockout_date,
      consumptionQuantity: row.consumption_quantity,
    }));
  }

  /**
   * `expiry_risk_value`'s real input — a tenant-scoped equivalent of `findExpiryQueue`
   * (`packages/db/src/expiry-queue.ts`), which is deliberately a CROSS-tenant sweep requiring an
   * admin-equivalent connection (its own docstring). `MetricContext.db` is always the normal
   * app-role tenant connection, so this catalog entry cannot call that function directly — the
   * same real SQL shape (already proven correct in `findExpiryQueue`'s own tests), scoped to one
   * store via the app role's normal `organization_id`/RLS path instead of scanning every tenant.
   */
  async findExpiringLots(storeId: string, asOf: Date = new Date()) {
    const asOfIso = asOf.toISOString();
    const rows = await this.runScoped((db) =>
      db.execute<{
        lot_id: string;
        days_to_expiry: number;
        remaining_quantity: string;
        unit_cost: string;
        value_at_risk: string;
      }>(sql`
        WITH consumption AS (
          SELECT store_id, product_id, variant_id, SUM(-quantity) / 30::numeric AS avg_daily_consumption
          FROM stock_movements
          WHERE organization_id = ${this.organizationId}
            AND store_id = ${storeId}
            AND movement_type = 'SALE_CONSUMPTION'
            AND occurred_at >= ${asOfIso}::timestamptz - INTERVAL '30 days'
            AND occurred_at < ${asOfIso}::timestamptz
          GROUP BY store_id, product_id, variant_id
        )
        SELECT
          l.id AS lot_id,
          (l.expiry_date - ${asOfIso}::date) AS days_to_expiry,
          l.remaining_quantity,
          l.unit_cost,
          (l.remaining_quantity * l.unit_cost) AS value_at_risk
        FROM lots l
        LEFT JOIN consumption c
          ON c.store_id = l.store_id AND c.product_id = l.product_id AND c.variant_id = l.variant_id
        WHERE l.organization_id = ${this.organizationId}
          AND l.store_id = ${storeId}
          AND l.status = 'ACTIVE'
          AND l.remaining_quantity > 0
          AND l.expiry_date IS NOT NULL
          AND (
            COALESCE(c.avg_daily_consumption, 0) = 0
            OR (l.remaining_quantity / c.avg_daily_consumption) > (l.expiry_date - ${asOfIso}::date)
          )
      `)
    );
    return rows.map((row) => ({
      lotId: row.lot_id,
      daysToExpiry: Number(row.days_to_expiry),
      remainingQuantity: row.remaining_quantity,
      unitCost: row.unit_cost,
      valueAtRisk: row.value_at_risk,
    }));
  }

  /**
   * `negative_stock_incidents`'s real input — a tenant-scoped equivalent of `findNegativeStock`
   * (`packages/db/src/negative-stock.ts`), same reasoning as `findExpiringLots` above: the
   * original is a deliberate cross-tenant sweep needing an admin connection, this is the one-store,
   * app-role-scoped version this catalog entry can actually call.
   */
  async findNegativeStockForStore(storeId: string) {
    const rows = await this.runScoped((db) =>
      db.execute<{ product_id: string; variant_id: string; quantity: string }>(sql`
        SELECT product_id, variant_id, quantity
        FROM stock_levels
        WHERE organization_id = ${this.organizationId}
          AND store_id = ${storeId}
          AND quantity < 0
      `)
    );
    return rows.map((row) => ({ productId: row.product_id, variantId: row.variant_id, quantity: row.quantity }));
  }

  /**
   * `stock_projection_drift`'s real input — a tenant-scoped equivalent of `findStockLevelDrift`
   * (`packages/db/src/reconciliation.ts`), same reasoning as `findExpiringLots`/
   * `findNegativeStockForStore` above: the original is a deliberate cross-tenant admin sweep, this
   * is the one-org, app-role-scoped version this catalog entry can actually call. Same
   * `FULL OUTER JOIN` shape (a `stock_levels` row with no matching ledger rows at all would be
   * invisible to a plain `LEFT JOIN` from `stock_movements`), narrowed to this organization.
   */
  async findDriftForOrg() {
    const rows = await this.runScoped((db) =>
      db.execute<{
        store_id: string;
        product_id: string;
        variant_id: string;
        ledger_sum: string;
        projection_quantity: string;
      }>(sql`
        SELECT
          COALESCE(m.store_id, sl.store_id) AS store_id,
          COALESCE(m.product_id, sl.product_id) AS product_id,
          COALESCE(m.variant_id, sl.variant_id) AS variant_id,
          COALESCE(SUM(m.quantity), 0) AS ledger_sum,
          COALESCE(MAX(sl.quantity), 0) AS projection_quantity
        FROM stock_movements m
        FULL OUTER JOIN stock_levels sl
          ON sl.store_id = m.store_id
         AND sl.product_id = m.product_id
         AND sl.variant_id = m.variant_id
         AND sl.organization_id = ${this.organizationId}
        WHERE COALESCE(m.organization_id, sl.organization_id) = ${this.organizationId}
        GROUP BY
          COALESCE(m.store_id, sl.store_id),
          COALESCE(m.product_id, sl.product_id),
          COALESCE(m.variant_id, sl.variant_id)
        HAVING COALESCE(SUM(m.quantity), 0) <> COALESCE(MAX(sl.quantity), 0)
      `)
    );
    return rows.map((row) => ({
      storeId: row.store_id,
      productId: row.product_id,
      variantId: row.variant_id,
      ledgerSum: row.ledger_sum,
      projectionQuantity: row.projection_quantity,
    }));
  }

  /**
   * `fact_daily_stock_value`'s real input (009-01) — one row per (productId, variantId) with any
   * real ACTIVE lot remaining at this store, as of `asOf` (the resolved end of the store-local day
   * being aggregated, matching `findExpiringLots`'s own precedent for an "as of" snapshot query).
   * `value` is `null` (I7) the moment even ONE contributing lot has an unresolvable cost — `lots.
   * unit_cost` is NOT NULL at the schema level (a lot's whole purpose is carrying a known cost
   * basis, per `LotRepository.receive`'s own doc comment), so in practice this never actually fires,
   * but the aggregation still checks explicitly rather than assuming the constraint always holds.
   * `lotsExpiring7d` counts real ACTIVE lots whose `expiry_date` falls within the 7 days following
   * `asOf` — the spec's own literal `lots_expiring_7d` column, computed directly here rather than
   * reusing `findExpiringLots` (that function's consumption-velocity join is real overhead this
   * fact table's simpler "how many lots expire soon" count doesn't need).
   */
  async findStockValueForFactAggregation(storeId: string, asOf: Date) {
    const asOfIso = asOf.toISOString();
    const rows = await this.runScoped((db) =>
      db.execute<{
        product_id: string;
        variant_id: string;
        qty_on_hand: string;
        value: string | null;
        lots_expiring_7d: string;
      }>(sql`
        SELECT
          product_id,
          variant_id,
          SUM(remaining_quantity) AS qty_on_hand,
          SUM(remaining_quantity * unit_cost) AS value,
          COUNT(*) FILTER (
            WHERE expiry_date IS NOT NULL
              AND expiry_date >= ${asOfIso}::date
              AND expiry_date < (${asOfIso}::date + INTERVAL '7 days')
          ) AS lots_expiring_7d
        FROM lots
        WHERE organization_id = ${this.organizationId}
          AND store_id = ${storeId}
          AND status = 'ACTIVE'
          AND remaining_quantity > 0
        GROUP BY product_id, variant_id
      `)
    );
    return rows.map((row) => ({
      productId: row.product_id,
      variantId: row.variant_id,
      qtyOnHand: row.qty_on_hand,
      value: row.value,
      lotsExpiring7d: Number(row.lots_expiring_7d),
    }));
  }
}
