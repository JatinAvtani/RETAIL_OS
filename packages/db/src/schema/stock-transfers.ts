import { numeric, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { products, productVariants } from './products';
import { lots } from './lots';
import { users } from './users';
import { idColumn, timestamps } from './columns';

export const stockTransferStatusEnum = pgEnum('stock_transfer_status', ['PENDING', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED']);

/**
 * earlier work (the design's `StockTransfer` entity, the plan's Phase 6: "paired TRANSFER_OUT/
 * TRANSFER_IN with an in-transit state; lots carry across with their original cost and expiry").
 * A `stock_movements` row is a point-in-time fact (I3 — append-only ledger), which cannot by
 * itself represent an ONGOING state like "still in transit" — this table is the thing that
 * actually holds that state, confirmed with the user as a real two-step lifecycle rather than a
 * single atomic OUT+IN pair: `initiateTransfer` immediately posts `TRANSFER_OUT` at the source
 * store (the stock is physically gone from there right away) and creates a NEW lot at the
 * destination store in a non-`ACTIVE` `IN_TRANSIT` status, carrying the ORIGINAL lot's cost and
 * expiry unchanged — never re-priced or re-dated by the transfer itself. That destination lot is
 * invisible to FEFO (`consumeFefo`/`findFefoCandidates` only ever query `status = 'ACTIVE'`) until
 * `receiveTransfer` posts `TRANSFER_IN` and flips it `ACTIVE` — mirroring the real physical
 * process: stock in a truck is gone from the sending store's usable inventory, and not yet usable
 * at the receiving store, for the whole transit window.
 *
 * `sourceLotId` (the lot drawn down at the origin) has a real FK; `destinationLotId` (the new lot
 * created at the destination) is nullable and only set once `initiateTransfer` has actually
 * created it — both point at the SAME conceptual batch of stock, at two different points on its
 * journey, never two independent lots with independent costs.
 *
 * `CANCELLED` covers a transfer that never completes (the shipment was lost, or never actually
 * sent) — reversing the source-side `TRANSFER_OUT` via a compensating movement (I3: never an
 * UPDATE/DELETE on the ledger) is `cancelTransfer`'s job, not built by simply deleting this row.
 */
export const stockTransfers = pgTable('stock_transfers', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  sourceStoreId: uuid('source_store_id')
    .notNull()
    .references(() => stores.id),
  destinationStoreId: uuid('destination_store_id')
    .notNull()
    .references(() => stores.id),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  variantId: uuid('variant_id')
    .notNull()
    .references(() => productVariants.id),
  quantity: numeric('quantity', { precision: 19, scale: 6 }).notNull(),
  status: stockTransferStatusEnum('status').notNull().default('PENDING'),
  sourceLotId: uuid('source_lot_id').references(() => lots.id),
  destinationLotId: uuid('destination_lot_id').references(() => lots.id),
  initiatedAt: timestamp('initiated_at', { withTimezone: true }),
  initiatedByUserId: uuid('initiated_by_user_id').references(() => users.id),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  receivedByUserId: uuid('received_by_user_id').references(() => users.id),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id),
  ...timestamps,
});
