import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type ExpiryQueueRow = {
  organizationId: string;
  storeId: string;
  productId: string;
  variantId: string;
  lotId: string;
  expiryDate: string;
  daysToExpiry: number;
  remainingQuantity: string;
  unitCost: string;
  valueAtRisk: string;
  avgDailyConsumption: string;
  consumptionCoverDays: number | null;
};

/**
 * 005-15 (plan.md Phase 6): ranks active lots by value at risk of expiring before they'll be used.
 * Rule-based, no AI — a suggestion the operator confirms, not a decision made for them.
 *
 * `avg_daily_consumption` doesn't exist anywhere as a stored or computed value yet, so this
 * function derives it inline: the trailing-30-day sum of `SALE_CONSUMPTION` movement quantities
 * (negative in the ledger) per (store, product, variant), divided by 30. 30 days was chosen (asked
 * the user) to smooth day-of-week noise while still reacting to a real recent demand shift, the
 * same tradeoff plan.md's own par-level discussion (005-09, spec 05 §5.1.3) makes for reorder math.
 *
 * `consumption_cover = remaining_quantity / avg_daily_consumption` is undefined for a product with
 * zero consumption in the window (new product, or a product that simply hasn't sold). Per I7 this
 * must not silently read as "safe" — a missing consumption signal is not evidence the stock will be
 * used in time. Asked the user: treated as an infinite cover (`consumption_cover_days: null` in the
 * output, `at_risk = remaining_quantity > 0`), so a zero-consumption lot with real remaining
 * quantity and a real expiry date is always surfaced, never silently excluded by a division by
 * zero.
 *
 * A lot with no `expiry_date` is excluded outright — `days_to_expiry` is meaningless for stock that
 * cannot expire, a genuinely different case from "unknown consumption," so it is filtered, not
 * defaulted.
 *
 * Only `status = 'ACTIVE' AND remaining_quantity > 0` lots are considered, mirroring the FEFO index
 * predicate (plan.md Phase 1) — a `DEPLETED` or already-`EXPIRED` lot has nothing left to lose.
 *
 * Deliberately cross-tenant by nature, same reasoning as `findStockLevelDrift`/`findBelowParLevels`/
 * `findNegativeStock` — an internal sweep across every tenant, not a single organization's scoped
 * request. `db` must be an admin-equivalent connection. Detection/ranking only: no event emission,
 * no notifications table, matching every other EPIC-005 sweep function's precedent.
 */
export const findExpiryQueue = async (db: Db, asOf: Date = new Date()): Promise<ExpiryQueueRow[]> => {
  const asOfIso = asOf.toISOString();
  const rows = await db.execute<{
    organization_id: string;
    store_id: string;
    product_id: string;
    variant_id: string;
    lot_id: string;
    expiry_date: string;
    days_to_expiry: number;
    remaining_quantity: string;
    unit_cost: string;
    value_at_risk: string;
    avg_daily_consumption: string;
    consumption_cover_days: number | null;
  }>(sql`
    WITH consumption AS (
      SELECT
        store_id,
        product_id,
        variant_id,
        SUM(-quantity) / 30.0 AS avg_daily_consumption
      FROM stock_movements
      WHERE movement_type = 'SALE_CONSUMPTION'
        AND occurred_at >= ${asOfIso}::timestamptz - INTERVAL '30 days'
        AND occurred_at < ${asOfIso}::timestamptz
      GROUP BY store_id, product_id, variant_id
    )
    SELECT
      l.organization_id,
      l.store_id,
      l.product_id,
      l.variant_id,
      l.id AS lot_id,
      l.expiry_date,
      (l.expiry_date - ${asOfIso}::date) AS days_to_expiry,
      l.remaining_quantity,
      l.unit_cost,
      (l.remaining_quantity * l.unit_cost) AS value_at_risk,
      COALESCE(c.avg_daily_consumption, 0) AS avg_daily_consumption,
      CASE
        WHEN COALESCE(c.avg_daily_consumption, 0) > 0
          THEN l.remaining_quantity / c.avg_daily_consumption
        ELSE NULL
      END AS consumption_cover_days
    FROM lots l
    LEFT JOIN consumption c
      ON c.store_id = l.store_id
     AND c.product_id = l.product_id
     AND c.variant_id = l.variant_id
    WHERE l.status = 'ACTIVE'
      AND l.remaining_quantity > 0
      AND l.expiry_date IS NOT NULL
      AND (
        -- zero/no consumption history: treated as at-risk whenever there's remaining quantity
        COALESCE(c.avg_daily_consumption, 0) = 0
        -- otherwise: at-risk only when consumption cover exceeds the time left before expiry
        OR (l.remaining_quantity / c.avg_daily_consumption) > (l.expiry_date - ${asOfIso}::date)
      )
    ORDER BY value_at_risk DESC
  `);

  return rows.map((row) => ({
    organizationId: row.organization_id,
    storeId: row.store_id,
    productId: row.product_id,
    variantId: row.variant_id,
    lotId: row.lot_id,
    expiryDate: row.expiry_date,
    daysToExpiry: Number(row.days_to_expiry),
    remainingQuantity: row.remaining_quantity,
    unitCost: row.unit_cost,
    valueAtRisk: row.value_at_risk,
    avgDailyConsumption: row.avg_daily_consumption,
    consumptionCoverDays: row.consumption_cover_days === null ? null : Number(row.consumption_cover_days),
  }));
};
