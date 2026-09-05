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
 * The exact state diagram. `SENT` is the immutability boundary — amendments
 * create a new version so what was actually sent to the supplier is preserved, matching
 * the `purchase_orders` entity-revisions mechanism (a full JSONB snapshot on send, not a new
 * row here — that snapshot lives in `audit_logs`/a future `*_revisions` table, out of this
 * schema's scope). `CANCELLED` is reachable from every pre-SENT-and-PARTIALLY_RECEIVED state per the
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
 * Whether the SENT state transition's real-world side effect (PDF generation + supplier email) has
 * actually happened — separate from `status` (which, once `SEND` fires, only ever means "the state
 * transition committed and this PO is now immutable"), for the exact same reason
 * `sales_transactions.consumption_status` is separate from `sales_transactions.status`: a business
 * event can be genuinely, correctly recorded while a side effect of it failed or never ran. The
 * `SEND` transition and this column are deliberately NOT merged into one bigger status enum — the
 * state machine (`applyPurchaseOrderTransition`) governs the PO's real business lifecycle
 * (draft/approval/receiving/closing), which does not change based on whether an email delivery
 * later succeeds or fails; overloading `SENT` into e.g. `SEND_REQUESTED`/`DELIVERED`/`DELIVERY_FAILED`
 * would force `PARTIALLY_RECEIVED`/`RECEIVE_FULL`/`CLOSE_SHORT` and every other downstream transition
 * to special-case which "SENT-shaped" status they may fire from, when none of them actually care.
 *
 * `PENDING` is the default the instant `applyTransition('SEND', ...)` commits — there is a real,
 * intentional window where the state transition is done but delivery has not yet been attempted
 * (the caller does PDF generation + email as a second, non-transactional step right after). A
 * `resend` mutation can move a `FAILED` (or still-`PENDING`, if the process crashed mid-flight) row
 * to `DELIVERED` without needing a further state-machine event — it does not change `status`, since
 * the PO was already, correctly, `SENT`.
 */
export const purchaseOrderDeliveryStatusEnum = pgEnum('purchase_order_delivery_status', ['PENDING', 'DELIVERED', 'FAILED']);

/**
 * `version` (optimisticVersion) prevents lost updates when two managers
 * edit the same PO concurrently. Separate
 * actor+timestamp column pairs per transition (`submittedAt`/`submittedByUserId`,
 * `approvedAt`/`approvedByUserId`, etc.) mirror `stock_counts`' established convention — each
 * terminal-or-milestone state is independently queryable ("show me every CANCELLED PO this
 * quarter") rather than folded into one shared `resolvedAt`/`resolvedByUserId` pair.
 *
 * `sentAt` is the literal immutability boundary ("SENT... becomes immutable")
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

  // SENT triggers PDF generation + email to the supplier contact.
  // `pdfObjectKey` is null until a SEND actually generates one (I7 — no PDF exists before that).
  // `emailSentAt`/`emailSentTo` record the (mocked, per this project's no-cost constraint) send
  // outcome directly on the row, so "was this actually sent, to whom" needs no audit_logs join.
  pdfObjectKey: text('pdf_object_key'),
  emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
  emailSentTo: text('email_sent_to'),

  // See `purchaseOrderDeliveryStatusEnum`'s own comment: a side-channel fact about whether the SENT
  // transition's real PDF/email side effect actually completed, independent of `status` itself.
  // Defaults `PENDING` the moment `SEND` commits; a `NULL`-safe default rather than nullable, since
  // every PO that has ever reached `SENT` has SOME real delivery-attempt fact worth tracking (POs
  // that never left DRAFT/APPROVED just carry the harmless default, never queried before SEND fires).
  deliveryStatus: purchaseOrderDeliveryStatusEnum('delivery_status').notNull().default('PENDING'),
  /** The real error message from the last failed delivery attempt (PDF generation or email send) — never overwritten on success, matching `sales_transactions.consumption_error`'s own precedent. */
  deliveryError: text('delivery_error'),
  deliveryAttempts: integer('delivery_attempts').notNull().default(0),

  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  ...timestamps,
  ...optimisticVersion,
});

/**
 * Quantities are stored in both supplier order units (cases) and base units (kg).
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
 * which needs the base-unit figure to create a lot and post a movement.
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
