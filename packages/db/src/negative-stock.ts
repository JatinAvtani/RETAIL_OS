import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type NegativeStockRow = {
  organizationId: string;
  storeId: string;
  productId: string;
  variantId: string;
  quantityOnHand: string;
};

/**
 * earlier work (the scope's M3 milestone, the plan's own acceptance criterion: "Negative stock raises
 * an alert but does NOT block the movement" — the plan's design decision: "Negative stock is a
 * signal, not an error — it means a receipt wasn't recorded. Alert; don't block."). A pure
 * detection function, the same scope precedent as `findStockLevelDrift` and
 * `findBelowParLevels`: no event emission (`stock.negative` is the design's named
 * event, but wiring it to an outbox write or a BullMQ alert job is out of scope here, matching
 * both prior precedents exactly), no notifications table. A future worker job or admin endpoint
 * decides what to do with the result; this function only reports which (store, product, variant)
 * combinations currently have negative `stock_levels.quantity`.
 *
 * No join needed (unlike `findBelowParLevels`, which needs `stock_par_levels` for a configured
 * threshold) — negative stock is self-evidently a signal regardless of any configured par level or
 * reorder point; a plain `WHERE quantity < 0` on the projection is the whole check. Reads
 * `stock_levels` (the projection), not the ledger directly — consistent with every other
 * dashboard-shaped read in this codebase, and cheap since the projection already answers "what's
 * on hand right now" without summing the ledger.
 *
 * Deliberately cross-tenant by nature, same reasoning as `findStockLevelDrift`/
 * `findBelowParLevels` — an internal sweep across every tenant, not a single organization's scoped
 * request. `db` must be an admin-equivalent connection.
 */
export const findNegativeStock = async (db: Db): Promise<NegativeStockRow[]> => {
  const rows = await db.execute<{
    organization_id: string;
    store_id: string;
    product_id: string;
    variant_id: string;
    quantity_on_hand: string;
  }>(sql`
    SELECT
      organization_id,
      store_id,
      product_id,
      variant_id,
      quantity AS quantity_on_hand
    FROM stock_levels
    WHERE quantity < 0
  `);

  return rows.map((row) => ({
    organizationId: row.organization_id,
    storeId: row.store_id,
    productId: row.product_id,
    variantId: row.variant_id,
    quantityOnHand: row.quantity_on_hand,
  }));
};
