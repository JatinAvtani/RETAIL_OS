import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { suppliers } from './suppliers';
import { purchaseOrders } from './purchase-orders';
import { goodsReceipts } from './goods-receipts';
import { documents } from './documents';
import { products } from './products';
import { idColumn, timestamps } from './columns';

/**
 * Spec 05 §5.3.3 (plan.md Phase 5, 008-13): "only measured events, no invented weights in MVP."
 * One row per real, already-happened fact about a supplier's performance — a delivery arriving
 * late, a receipt short of what was ordered, an invoice's price variance, a damaged/wrong-item
 * receipt line. Every component metric (fill rate, on-time rate, price variance, invoice accuracy,
 * quality reject rate) reads FROM these events (I2 — packages/metrics is the sole read path), never
 * recomputed ad hoc from purchase_orders/goods_receipts/invoice_matches directly by a consumer.
 *
 * `expectedValue`/`actualValue`/`variance` are all nullable — an event type that has no natural
 * numeric comparison (plan.md's own literal schema still names these three generically across all
 * event types) leaves them `null` rather than fabricating a 0 (I7). `purchaseOrderId`/
 * `goodsReceiptId`/`documentId`/`productId` are provenance columns, all nullable since not every
 * event type has all four (a PRICE_VARIANCE event has a documentId but not necessarily a
 * goodsReceiptId; a DELIVERY_LATE event has a goodsReceiptId but no documentId) — each drillable to
 * whichever source rows actually produced it, matching spec 05 §5.3.3's "drillable to source
 * documents" requirement for the scorecard (008-15) this table ultimately feeds.
 *
 * Deliberately no `pgEnum` for `eventType` — a plain `text` column with an app-layer union as the
 * source of truth, matching `discrepancyCode`'s/`invoiceMatches.status`'s own established
 * precedent for this exact shape of fixed-but-app-owned vocabulary in this codebase.
 *
 * Append-only, like `stock_movements` (I3's spirit extended here) — a correction is a new event,
 * never an UPDATE/DELETE on a past measurement; the events feeding a trend are a historical record
 * of what was actually true at each point in time, not a mutable running total.
 */
export const supplierPerformanceEvents = pgTable('supplier_performance_events', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => suppliers.id),
  eventType: text('event_type').notNull(),

  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id),
  goodsReceiptId: uuid('goods_receipt_id').references(() => goodsReceipts.id),
  documentId: uuid('document_id').references(() => documents.id),
  productId: uuid('product_id').references(() => products.id),

  expectedValue: numeric('expected_value', { precision: 19, scale: 6 }),
  actualValue: numeric('actual_value', { precision: 19, scale: 6 }),
  variance: numeric('variance', { precision: 19, scale: 6 }),

  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  ...timestamps,
});

/**
 * Matches plan.md's own literal list exactly. `QUALITY_REJECT` (confirmed with the user, 008-13):
 * a DAMAGED/WRONG_ITEM discrepancy-coded receipt line has no distinct "how much of this was
 * rejected vs. accepted" figure in this codebase yet — the line's own `receivedQuantityBaseUnits`
 * is used as the rejected amount (the honest reading of the only number that actually exists),
 * not a fabricated partial split.
 */
export const supplierPerformanceEventTypeEnum = [
  'DELIVERY_ON_TIME',
  'DELIVERY_LATE',
  'FILL_COMPLETE',
  'FILL_SHORT',
  'PRICE_VARIANCE',
  'QUALITY_REJECT',
  'INVOICE_CLEAN',
  'INVOICE_ERROR',
  /**
   * 008-14 (spec 05 §5.3.4): a real, threshold-crossing price change detected between two
   * consecutive `supplier_prices` rows for the same supplier product — `expectedValue`/
   * `actualValue` are the old/new unit price, `variance` is the real `annualized_impact` dollar
   * figure (`Δunit_price × trailing_12mo_quantity`), `'unknown'`-mapped to `null` when no trailing
   * receiving history exists yet (I7). Distinct from `PRICE_VARIANCE` (008-13): that event compares
   * an invoiced price against the PO's agreed price on ONE invoice; this one compares two
   * consecutive real prices over time, regardless of whether a PO was ever involved.
   */
  'PRICE_CHANGE',
] as const;
export type SupplierPerformanceEventType = (typeof supplierPerformanceEventTypeEnum)[number];
