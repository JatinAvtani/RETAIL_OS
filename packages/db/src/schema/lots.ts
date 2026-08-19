import { char, date, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { products, productVariants } from './products';
import { suppliers } from './suppliers';
import { idColumn, timestamps } from './columns';

export const lotStatusEnum = pgEnum('lot_status', ['ACTIVE', 'DEPLETED', 'EXPIRED', 'IN_TRANSIT']);

/**
 * A received batch with expiry and actual cost — the workhorse for FEFO
 * allocation, expiry tracking, and true cost-of-consumption. Every `RECEIPT` movement creates one
 * of these.
 *
 * `status` values are not spec-enumerated (only `ACTIVE` appears explicitly, in the plan's FEFO
 * index, and `lot.expired` as an event name) — decided explicitly: `ACTIVE` (remaining_quantity
 * > 0, eligible for FEFO), `DEPLETED` (remaining_quantity reached 0 through normal
 * consumption/waste — a natural terminal state, not an error), `EXPIRED` (expiry_date passed
 * while stock remained — a distinct terminal state representing loss, not use). Transitioning
 * ACTIVE → EXPIRED is a background job / query-time concern for a later task (earlier work's expiry
 * queue), not built here — this schema only defines the state space.
 *
 * `IN_TRANSIT` added later, matching migration `0022`'s `ALTER TYPE... ADD VALUE` —
 * this Drizzle schema declaration must stay in sync with the real Postgres enum by hand for every
 * value added after the original `CREATE TYPE`, since Drizzle has no migration-time introspection
 * of enum values; a destination lot created by `TransferService.initiateTransfer` starts here,
 * deliberately excluded from every FEFO query (which only ever selects `status = 'ACTIVE'`) until
 * `receiveTransfer` flips it.
 *
 * `remaining_quantity` starts equal to `initial_quantity` and only ever decreases (FEFO
 * allocation, waste, transfers-out) — enforced as a real CHECK constraint
 * (`lots_remaining_within_initial`, added in the migration), not just repository discipline.
 *
 * `supplier_id` has a real FK (suppliers exists). `goods_receipt_line_id`/`source_document_id`
 * do NOT — the tables they'd reference (purchasing/receiving is a later milestone, documents is a later milestone)
 * don't exist yet in this codebase. Same deferred-FK pattern already used for
 * `stock_movements.lot_id` before this table existed: the columns are here now so a later
 * migration doesn't need to add them, the real FK constraints arrive once those epics build their
 * tables.
 *
 * NOT partitioned, unlike `stock_movements` — the design's partitioning table only lists
 * `stock_movements`, `sales_transactions`/`_lines`, `audit_logs`, `notifications`, and fact
 * tables; `lots` is actively queried by status/expiry, not an append-only high-volume ledger.
 */
export const lots = pgTable('lots', {
  id: idColumn(),
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
  lotNumber: text('lot_number'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  expiryDate: date('expiry_date', { mode: 'string' }),
  initialQuantity: numeric('initial_quantity', { precision: 19, scale: 6 }).notNull(),
  remainingQuantity: numeric('remaining_quantity', { precision: 19, scale: 6 }).notNull(),
  unitCost: numeric('unit_cost', { precision: 19, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  supplierId: uuid('supplier_id').references(() => suppliers.id),
  goodsReceiptLineId: uuid('goods_receipt_line_id'),
  sourceDocumentId: uuid('source_document_id'),
  status: lotStatusEnum('status').notNull().default('ACTIVE'),
  ...timestamps,
});
