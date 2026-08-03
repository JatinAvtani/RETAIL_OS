import { char, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { menuItems } from './recipes';

export const unmappedSaleStatusEnum = pgEnum('unmapped_sale_status', ['UNRESOLVED', 'RESOLVED', 'IGNORED']);

/**
 * 005-08 (spec 05 §5.1.3, plan.md Phase 4): the quarantine queue for a sale line whose POS item
 * cannot be resolved to a `MenuItem`. The point of this table — "revenue counts, consumption
 * doesn't, nothing is silently dropped" — is that an unmapped item is a data-completeness problem
 * to surface, not a reason to drop the sale or guess at its recipe (I7). Silently dropping it would
 * understate consumption and overstate margin; the same failure shape 005-07 already guards
 * against for a menu item with no recipe.
 *
 * Sales-source-agnostic, same reasoning as `SaleConsumptionService` (005-07):
 * `pos_items`/`sales_transactions` don't exist anywhere in this codebase yet — they belong
 * entirely to EPIC-006 (Sales Ingestion), which is blocked ON EPIC-005 and hasn't started.
 * Confirmed with the user rather than assumed: this table stores the raw external identifying
 * fields a POS sale line carries (`posItemExternalId`/`posItemName`), not a foreign key to a table
 * that doesn't exist. Whatever EPIC-006 builds to ingest a sale is the eventual writer here.
 *
 * `revenue` is carried on the row (not looked up elsewhere) precisely so revenue recognition
 * doesn't depend on consumption ever being resolved — the two are deliberately decoupled per
 * plan.md's acceptance criterion.
 *
 * Resolution is a status transition, not a delete: `resolvedMenuItemId` (nullable, set only once a
 * real mapping is confirmed) plus `resolvedAt`/`resolvedByUserId` record who fixed it and when,
 * without ever removing the historical fact that this sale line was once unmapped. `IGNORED` covers
 * a genuinely non-menu sale line (e.g. a gift card, a service charge) that a human has confirmed
 * will never need a recipe mapping — distinct from `RESOLVED`, which always carries a real
 * `resolvedMenuItemId`.
 */
export const unmappedSales = pgTable('unmapped_sales', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  posItemExternalId: text('pos_item_external_id').notNull(),
  posItemName: text('pos_item_name').notNull(),
  quantitySold: numeric('quantity_sold', { precision: 19, scale: 6 }).notNull(),
  revenue: numeric('revenue', { precision: 19, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  status: unmappedSaleStatusEnum('status').notNull().default('UNRESOLVED'),
  resolvedMenuItemId: uuid('resolved_menu_item_id').references(() => menuItems.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedByUserId: uuid('resolved_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
