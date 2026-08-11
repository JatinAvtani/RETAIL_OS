import { integer, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { suppliers } from './suppliers';
import { supplierProducts } from './supplier-products';
import { products, productVariants } from './products';
import { units } from './units';
import { users } from './users';
import { idColumn, timestamps, optimisticVersion } from './columns';

/**
 * Spec 05 §5.2.2's exact state diagram. `SENT` is the immutability boundary — plan.md: "amendments
 * create a new version so what was actually sent to the supplier is preserved," matching spec 08
 * §8.2's `purchase_orders` entity-revisions mechanism (a full JSONB snapshot on send, not a new
 * row here — that snapshot lives in `audit_logs`/a future `*_revisions` table, out of this task's
 * schema scope). `CANCELLED` is reachable from every pre-SENT-and-PARTIALLY_RECEIVED state per the
 * spec; the domain-layer state machine (packages/domain/src/purchasing/po-lifecycle.ts) is the
 * single source of truth for which transitions are valid — this enum only constrains which VALUES
 * are representable, not which sequences are legal.
 */
export const purchaseOrderStatusEnum = pgEnum('purchase_order_status', [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
]);

/**
 * Spec 05 §5.2.2 / 07 §7.5. `version` (optimisticVersion) prevents lost updates when two managers
 * edit the same PO concurrently (spec 08 §8.2's literal example uses this exact table). Separate
 * actor+timestamp column pairs per transition (`submittedAt`/`submittedByUserId`,
 * `approvedAt`/`approvedByUserId`, etc.) mirror `stock_counts`' established convention — each
 * terminal-or-milestone state is independently queryable ("show me every CANCELLED PO this
 * quarter") rather than folded into one shared `resolvedAt`/`resolvedByUserId` pair.
 *
 * `sentAt` is the literal immutability boundary spec 05 §5.2.2 names ("SENT... becomes immutable")
 * — application code must refuse further line/header edits once this is non-null, enforced in the
 * repository layer (a DB CHECK constraint can't express "no UPDATE to certain columns after a
 * certain state" without a trigger, which this project has avoided elsewhere in favor of
 * application-layer enforcement matching the existing `supplier_products.isConfirmed` precedent).
 *
 * `approvalThresholdAppliedCents` records the org's approval-threshold config value AT THE TIME OF
 * SUBMISSION (not a live reference to current config), so a later config change never silently
 * rewrites the historical rule that actually governed this PO's approval — same "snapshot what was
 * true then" discipline as `stock_count_lines.t0UnitCost`.
 */
export const purchaseOrders = pgTable('purchase_orders', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => suppliers.id),
  status: purchaseOrderStatusEnum('status').notNull().default('DRAFT'),
  poNumber: text('po_number').notNull(),
  currency: text('currency').notNull(),
  expectedDeliveryDate: timestamp('expected_delivery_date', { withTimezone: true }),
  notes: text('notes'),

  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedByUserId: uuid('submitted_by_user_id').references(() => users.id),

  approvalThresholdAppliedCents: numeric('approval_threshold_applied_cents', { precision: 19, scale: 4 }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id),

  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectedByUserId: uuid('rejected_by_user_id').references(() => users.id),
  rejectionReason: text('rejection_reason'),

  sentAt: timestamp('sent_at', { withTimezone: true }),
  sentByUserId: uuid('sent_by_user_id').references(() => users.id),

  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id),
  cancellationReason: text('cancellation_reason'),

  closedAt: timestamp('closed_at', { withTimezone: true }),

  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  ...timestamps,
  ...optimisticVersion,
});

/**
 * Spec 05 §5.2.2: "Quantities are stored in both supplier order units (cases) and base units (kg).
 * Every unit conversion failure in a purchasing system becomes a stock error; the conversion is
 * done once, at PO creation, and stored." `conversionToBase` is recorded on the LINE (not looked up
 * live from `unit_conversions`/`supplier_products` at receiving time) for the same reason
 * `stock_count_lines.t0UnitCost` freezes a value rather than re-deriving it later — the conversion
 * factor that was true when the order was placed must not silently drift if the supplier's pack
 * size configuration changes before the PO is received.
 *
 * `unitPrice` is per ORDER unit (matches `supplier_prices.unitPrice`'s own convention — a supplier
 * quotes per case/pack, not per base unit), so `lineTotal = quantityOrderUnits * unitPrice` needs
 * no conversion at all; `quantityBaseUnits` exists purely for the receiving/stock-posting side
 * (008-07+), which needs the base-unit figure to create a lot and post a movement.
 *
 * `receivedQuantityBaseUnits` starts NULL, not `0` — "not yet received" must never read as "zero
 * received" (I7), the same discipline `stock_count_lines.countedQuantity` already established.
 */
export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  purchaseOrderId: uuid('purchase_order_id')
    .notNull()
    .references(() => purchaseOrders.id),
  supplierProductId: uuid('supplier_product_id')
    .notNull()
    .references(() => supplierProducts.id),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  variantId: uuid('variant_id').references(() => productVariants.id),

  quantityOrderUnits: numeric('quantity_order_units', { precision: 19, scale: 6 }).notNull(),
  orderUnitId: uuid('order_unit_id').references(() => units.id),
  conversionToBase: numeric('conversion_to_base', { precision: 19, scale: 9 }).notNull(),
  quantityBaseUnits: numeric('quantity_base_units', { precision: 19, scale: 6 }).notNull(),
  baseUnitId: uuid('base_unit_id').references(() => units.id),

  unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
  lineTotal: numeric('line_total', { precision: 19, scale: 4 }).notNull(),

  receivedQuantityBaseUnits: numeric('received_quantity_base_units', { precision: 19, scale: 6 }),

  lineNumber: integer('line_number').notNull(),
  ...timestamps,
});
