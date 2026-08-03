import { numeric, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { products, productVariants } from './products';

/**
 * The projection (spec 08 §8.6) — a cache of "what's on hand right now," maintained in the SAME
 * transaction as every `stock_movements` insert (`INSERT ... ON CONFLICT DO UPDATE`). The ledger
 * is truth; this table exists purely for O(1) read performance instead of summing the ledger on
 * every page load. Drift between this table and the ledger sum is a bug, not a data-quality
 * nuance — that's what the nightly reconciliation job (005-04) alerts on.
 *
 * Primary key is `(store_id, product_id, variant_id)`, exactly as spec 08 §8.6 defines it — no
 * `organization_id` in the key, since a store already implies its organization. `organization_id`
 * is still carried as its own column (not part of the key) so this table can extend
 * `TenantScopedRepository` and get the standard RLS policy like every other tenant table — a
 * projection with no direct tenant column would be the one exception to this codebase's "every
 * tenant-scoped repository has an explicit organization_id WHERE-clause" rule for no good reason.
 *
 * `quantity` starts at 0 by DEFAULT (not NULL) — an untouched product/variant/store combination
 * genuinely has zero stock, which is a known fact, not a missing one (I7 only forbids defaulting
 * an UNKNOWN quantity to zero; a real projection that has never seen a movement is legitimately
 * zero). `avgUnitCost` stays nullable with no default — the average cost of stock on hand is
 * unknown until at least one costed movement has been posted, and must say so (I7), never claim
 * `0.00`.
 */
export const stockLevels = pgTable(
  'stock_levels',
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
    quantity: numeric('quantity', { precision: 19, scale: 6 }).notNull().default('0'),
    avgUnitCost: numeric('avg_unit_cost', { precision: 19, scale: 4 }),
    lastMovementAt: timestamp('last_movement_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.storeId, table.productId, table.variantId] }),
  }),
);
