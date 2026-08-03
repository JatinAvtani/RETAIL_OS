import { numeric, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { products, productVariants } from './products';

/**
 * 005-09 (spec 03-product-scope.md M3: "Par levels and reorder points per product per store"):
 * pure data storage, confirmed with the user. The full deterministic reorder-suggestion FORMULA
 * (spec 05 §5.2.1 — daily consumption, lead time, safety stock, coverage days) is a separate,
 * later task (008-02, EPIC-008, blocked on EPIC-005+007, not started) that reads `reorderPoint` as
 * one input among several; this table does not compute anything, and `stock.below_par` event
 * emission/alerting is likewise out of scope here (not in EPIC-005's own task list, same
 * detection-only precedent as 005-04's `findStockLevelDrift`).
 *
 * `parLevel` and `reorderPoint` are separate columns because they answer different questions: par
 * level is "how much should be on hand at a glance" (spec 05 §5.1.3's fallback for a brand-new
 * product with no consumption history yet — "use par level only"), reorder point is "the threshold
 * that triggers a reorder" (spec 05 §5.2.1's `daily_consumption × lead_time + safety_stock`, a
 * different, larger number in practice). Both nullable — a product/store combination with no
 * par-level policy set yet is a known "not configured" state (I7), never defaulted to 0, which
 * would silently read as "already below par."
 *
 * Same composite-key shape as `stock_levels` (`store_id`, `product_id`, `variant_id`) — this is
 * fundamentally a setting about the same real-world entity (`stock_levels` tracks WHAT is on hand;
 * this tracks the threshold that quantity is compared against), so mirroring its key avoids a
 * second, incompatible way of identifying "this product at this store."
 */
export const stockParLevels = pgTable(
  'stock_par_levels',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id),
    parLevel: numeric('par_level', { precision: 19, scale: 6 }),
    reorderPoint: numeric('reorder_point', { precision: 19, scale: 6 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.storeId, table.productId, table.variantId] }),
  }),
);
