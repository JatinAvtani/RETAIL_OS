import { integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { suppliers } from './suppliers';
import { purchaseOrders, purchaseOrderLines } from './purchase-orders';
import { products, productVariants } from './products';
import { units } from './units';
import { users } from './users';
import { idColumn, timestamps } from './columns';

/**
 * the design / 07 the design's `GoodsReceipt`/`GoodsReceiptLine`: "what physically arrived."
 * Deliberately no state machine of its own (unlike `purchase_orders`) — a receipt is recorded once,
 * atomically, on confirm; there is no draft/edit/re-open concept for a receipt itself (a correction
 * is a NEW receipt or a stock-count adjustment, matching this project's append-only bias — I3's
 * spirit extended to a table that isn't `stock_movements` itself but exists to feed it).
 *
 * `purchaseOrderId` is nullable — earlier work (receipt without PO, walk-in/emergency purchases) is a
 * real, confirmed later scope, not solved here, but the column is nullable now so that task doesn't
 * need a migration of its own to loosen a NOT NULL constraint (same deferred-column precedent as
 * `lots.goodsReceiptLineId` itself, added back in earlier work for exactly this epic).
 */
export const goodsReceipts = pgTable('goods_receipts', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => suppliers.id),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  receivedByUserId: uuid('received_by_user_id').references(() => users.id),
  notes: text('notes'),
  ...timestamps,
});

/**
 * `discrepancyCode` matches the plan's literal fixed set — a plain nullable `text` column (not a
 * `pgEnum`) with an app-layer `DiscrepancyCode` union as the single source of truth, mirroring
 * `wasteReasonCodeEnum`'s own precedent, since a CHECK constraint on a nullable multi-select-shaped
 * column adds little here (only one discrepancy per line, the simple case the plan describes).
 * `null` means "arrived exactly as ordered" — never a fabricated `'NONE'` string (I7).
 *
 * `receivedQuantityBaseUnits` is REQUIRED (not nullable) — unlike `purchase_order_lines.
 * receivedQuantityBaseUnits` (which starts null meaning "not yet received"), a goods_receipt_line
 * only exists because a real receiving event happened, so "how much arrived" must always be a real
 * recorded number, even if that number is `0` (a `WRONG_ITEM`/fully-missing line still needs a row
 * to record the discrepancy against, with quantity `0`).
 *
 * `lotId` is set once `MovementService.postMovementInTx`'s `RECEIPT` movement creates the real lot
 * (GoodsReceiptRepository's job) — nullable only for the brief moment between line-input capture and
 * lot creation within the SAME transaction; every persisted row has a real lot by the time the
 * transaction commits, but the column can't be NOT NULL at the table-definition level since the
 * insert order within that transaction creates the receipt line before the lot in some call shapes.
 * `photoObjectKeys` is a real jsonb array column added
 * now, unused until earlier work wires an upload path to it — matches `lots.goodsReceiptLineId`'s own
 * "add the column now, wire the feature later" precedent, not a placeholder abstraction.
 *
 * NOTE: `lot_id` here and `lots.goods_receipt_line_id` form a genuine MUTUAL FK cycle — this table
 * references a lot, and that lot references back to this row. Neither table can ever be deleted
 * first; any teardown (test cleanup, a future admin tool) must null one side's FK column before
 * deleting either table. This project's append-only bias means the cycle is never exercised in
 * normal operation (nothing deletes a receipt or a lot), but it is real and must be handled
 * correctly wherever test fixtures tear down both tables together.
 */
export const goodsReceiptLines = pgTable('goods_receipt_lines', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  goodsReceiptId: uuid('goods_receipt_id')
    .notNull()
    .references(() => goodsReceipts.id),
  purchaseOrderLineId: uuid('purchase_order_line_id').references(() => purchaseOrderLines.id),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  variantId: uuid('variant_id')
    .notNull()
    .references(() => productVariants.id),

  receivedQuantityBaseUnits: numeric('received_quantity_base_units', { precision: 19, scale: 6 }).notNull(),
  baseUnitId: uuid('base_unit_id').references(() => units.id),
  unitCost: numeric('unit_cost', { precision: 19, scale: 4 }),
  currency: text('currency'),

  lotNumber: text('lot_number'),
  expiryDate: text('expiry_date'),
  lotId: uuid('lot_id'),

  discrepancyCode: text('discrepancy_code'),
  discrepancyNotes: text('discrepancy_notes'),
  photoObjectKeys: jsonb('photo_object_keys'),

  lineNumber: integer('line_number').notNull(),
  ...timestamps,
});

export const discrepancyCodeEnum = ['SHORT', 'OVER', 'DAMAGED', 'WRONG_ITEM', 'LATE'] as const;
export type DiscrepancyCode = (typeof discrepancyCodeEnum)[number];
