import { char, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { menuItems } from './recipes';
import { idColumn, timestamps } from './columns';

/**
 * 006-01 (plan.md Phase 1): the two ingestion sources this codebase actually builds — Square (the
 * only vendor shipping, per task.md) and CSV (the universal fallback, "what makes the product
 * sellable to anyone during the design-partner phase"). Not a free-text column: every sales row's
 * provenance is one of a fixed, known set, same reasoning as `store_status`/`lot_status`.
 */
export const salesSourceEnum = pgEnum('sales_source', ['square', 'csv']);

export const posItemMappingStatusEnum = pgEnum('pos_item_mapping_status', ['UNMAPPED', 'MAPPED', 'IGNORED']);

export const salesTransactionStatusEnum = pgEnum('sales_transaction_status', ['COMPLETED', 'REFUNDED', 'VOIDED']);

/**
 * One item as the POS vendor's catalog names it — NOT a `Product`/`MenuItem`. `pos_items` is the
 * left side of the fuzzy-match mapping problem 006-11's UI solves; `menuItemId` stays NULL until a
 * human confirms a mapping (I9 — mapping is deterministic and human-confirmed, never automatic).
 * `mappingStatus` mirrors `unmappedSaleStatusEnum`'s three-way split for the same reason: `IGNORED`
 * covers a real POS catalog entry (a gift card, a service charge) that will never have a recipe,
 * distinct from `UNMAPPED` (not yet looked at).
 *
 * Uniqueness is on `(organization_id, store_id, source, external_id)`, not just `external_id` —
 * vendor-issued ids are only unique within that vendor's own account, and one org can have two
 * stores each with their own Square location (their own catalog + external ids can collide
 * trivially, e.g. both use Square's own auto-incrementing internal counters).
 *
 * Deleted-upstream items are marked (`lastSeenAt` stops advancing), never deleted — plan.md Phase 2
 * is explicit that historical sales still reference them via `sales_transaction_lines.posItemId`.
 */
export const posItems = pgTable(
  'pos_items',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    source: salesSourceEnum('source').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    price: numeric('price', { precision: 19, scale: 4 }),
    currency: char('currency', { length: 3 }),
    category: text('category'),
    menuItemId: uuid('menu_item_id').references(() => menuItems.id),
    mappingStatus: posItemMappingStatusEnum('mapping_status').notNull().default('UNMAPPED'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * 006-04 (plan.md Phase 2): "deleted upstream items are marked, not deleted — historical sales
     * still reference them." NULL means still present in the vendor's catalog as of the last sync;
     * non-null is the moment a full catalog sync completed without seeing this item's external id
     * again (Square's own `is_deleted` flag, or simply absent from a full sync's result set). Kept
     * separate from `mappingStatus` deliberately — "no longer sold" and "not yet mapped to a menu
     * item" are two independent facts about the same row, and conflating them into one enum would
     * lose whichever one isn't currently active.
     */
    delistedAt: timestamp('delisted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('pos_items_store_source_external_id_idx').on(table.storeId, table.source, table.externalId)]
);

/**
 * One POS sale (a Square order, a CSV row group) — the header. Idempotency is the whole point of
 * this table's shape (006-07, plan.md Phase 3, spec 05 §5.1.3): the unique index on
 * `(source, external_id)` is what makes `.onConflictDoNothing()` in the future ingestion pipeline a
 * real guarantee rather than a hope. Scoped per-organization, not globally, for the same reason
 * `pos_items` is — the SAME external id from two different vendors' accounts (two different orgs
 * each on their own Square account) is not the same transaction.
 *
 * `refundOfId` is nullable, self-referencing: a `REFUNDED` row points back at the `COMPLETED`
 * transaction it reverses. This table records the FACT of a refund; reversing the consumption
 * movements it caused is 006-08's job, one level up, against `stock_movements` (I3 — never an
 * UPDATE/DELETE on the original sale row itself).
 *
 * `subtotal`/`discount`/`tax`/`total` are separate columns, not derived — a vendor's own rounding
 * and tax rules produced these numbers; recomputing them here would risk disagreeing with the
 * vendor's receipt over a cent, which is a support nightmare, not a bug worth "fixing".
 */
export const salesTransactions = pgTable(
  'sales_transactions',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    source: salesSourceEnum('source').notNull(),
    externalId: text('external_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    channel: text('channel'),
    subtotal: numeric('subtotal', { precision: 19, scale: 4 }).notNull(),
    discount: numeric('discount', { precision: 19, scale: 4 }).notNull(),
    tax: numeric('tax', { precision: 19, scale: 4 }).notNull(),
    total: numeric('total', { precision: 19, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: salesTransactionStatusEnum('status').notNull().default('COMPLETED'),
    refundOfId: uuid('refund_of_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('sales_transactions_org_source_external_id_idx').on(table.organizationId, table.source, table.externalId),
  ]
);

/**
 * One line within a transaction. `organizationId` is denormalized here directly (not looked up via
 * a join to `sales_transactions`) — same convention `stock_count_lines` already established: every
 * table `TenantScopedRepository` guards needs its own real `organization_id` column, so the
 * app-layer tenant predicate doesn't depend on a join succeeding.
 *
 * `posItemId` is nullable: a line can arrive before `pos_items` has ever seen that external item
 * (a brand-new catalog entry, or a CSV import with no prior catalog sync at all) — 006's ingestion
 * pipeline's job to backfill/create the `pos_items` row, not this schema's. `modifiers` is jsonb,
 * matching `product_variants.attributes`'s existing precedent for vendor-shaped, non-queried detail
 * that exists for display/audit only, never for a calculation this codebase performs.
 */
export const salesTransactionLines = pgTable('sales_transaction_lines', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  transactionId: uuid('transaction_id')
    .notNull()
    .references(() => salesTransactions.id),
  posItemId: uuid('pos_item_id').references(() => posItems.id),
  quantity: numeric('quantity', { precision: 19, scale: 6 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
  discount: numeric('discount', { precision: 19, scale: 4 }).notNull(),
  lineTotal: numeric('line_total', { precision: 19, scale: 4 }).notNull(),
  modifiers: jsonb('modifiers'),
  ...timestamps,
});
