import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type BelowParRow = {
  organizationId: string;
  storeId: string;
  productId: string;
  variantId: string;
  quantityOnHand: string;
  reorderPoint: string;
};

/**
 * earlier work's detection half, confirmed with the user as detection-only (no `stock.below_par` event
 * emission, no notifications table, no BullMQ job) — the same scope precedent as
 * `findStockLevelDrift`. A future worker job or admin endpoint decides what to do with
 * the result; this function only reports which (store, product, variant) combinations are
 * currently at or below their configured reorder point.
 *
 * An `INNER JOIN` (not `LEFT`/`FULL OUTER`, unlike `findStockLevelDrift`) is correct here — a
 * product/store with no `stock_par_levels` row at all has no reorder point configured, which is a
 * genuinely different state from "configured and currently satisfied" (I7: absence of a threshold
 * must not silently read as "fine," but it also must not be reported as "below par" — there is no
 * par to be below). Only rows where `reorder_point IS NOT NULL` can ever match; a row with
 * `parLevel` set but `reorderPoint` left null is a real, intentional state (par-level-only
 * tracking, the design's fallback for a brand-new product with no consumption history) and is
 * correctly excluded from this specific check.
 *
 * Deliberately cross-tenant by nature, same reasoning as `findStockLevelDrift` — an internal sweep
 * across every tenant, not a single organization's scoped request. `db` must be an
 * admin-equivalent connection.
 */
export const findBelowParLevels = async (db: Db): Promise<BelowParRow[]> => {
  const rows = await db.execute<{
    organization_id: string;
    store_id: string;
    product_id: string;
    variant_id: string;
    quantity_on_hand: string;
    reorder_point: string;
  }>(sql`
    SELECT
      sl.organization_id,
      sl.store_id,
      sl.product_id,
      sl.variant_id,
      sl.quantity AS quantity_on_hand,
      pl.reorder_point
    FROM stock_levels sl
    INNER JOIN stock_par_levels pl
      ON pl.store_id = sl.store_id
     AND pl.product_id = sl.product_id
     AND pl.variant_id = sl.variant_id
    WHERE pl.reorder_point IS NOT NULL
      AND sl.quantity <= pl.reorder_point
  `);

  return rows.map((row) => ({
    organizationId: row.organization_id,
    storeId: row.store_id,
    productId: row.product_id,
    variantId: row.variant_id,
    quantityOnHand: row.quantity_on_hand,
    reorderPoint: row.reorder_point,
  }));
};
