import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { suppliers } from './suppliers';
import { users } from './users';
import { documents } from './documents';
import { purchaseOrders, purchaseOrderLines } from './purchase-orders';
import { goodsReceiptLines } from './goods-receipts';
import { products } from './products';
import { idColumn, timestamps } from './columns';

/**
 * Spec 05 §5.2.4 / 07 §7.5's `InvoiceMatch`: "the three-way match result linking PO ↔ Receipt ↔
 * Document, with per-line variance classification and resolution state." One row per matched
 * invoice document — `purchaseOrderId` is nullable (an invoice can match receipt lines from a
 * walk-in/no-PO receipt, 008-09's own scope, or match nothing at all, the "invoiced but never
 * received" case plan.md names as high-priority/possible-fraud). `documentId` has no unique
 * constraint at the DB level for the same reason `document_extractions` allows re-extraction:
 * matching is a computed result, not an immutable fact, and could in principle be re-run — the
 * app layer (008-10's repository) is responsible for not creating duplicate matches for the same
 * document in normal operation.
 *
 * `status` is deliberately NOT `pgEnum` — `PENDING`/`REVIEWED`/`RESOLVED`, an app-layer union
 * matching `discrepancyCode`'s own precedent. 008-12 confirmed with the user: one resolution
 * action, `PENDING` -> `RESOLVED` directly with a required reason — `REVIEWED` is a real,
 * representable value (kept for forward compatibility, matching every enum-widening precedent in
 * this codebase) but has no real transition into it yet; nothing currently sets it.
 * `resolvedAt`/`resolvedByUserId`/`resolutionNotes` mirror `purchase_orders.rejectedAt`/
 * `rejectedByUserId`/`rejectionReason`'s exact column-triple convention.
 */
export const invoiceMatches = pgTable('invoice_matches', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => suppliers.id),
  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id),

  status: text('status').notNull().default('PENDING'),
  highestSeverity: text('highest_severity'),

  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id),
  resolutionNotes: text('resolution_notes'),

  matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
});

/**
 * One row per INVOICE line, always — even a line with no PO/receipt match at all (the "unordered
 * item" / "invoiced but never received" cases in plan.md's variance table), since the whole point
 * of this table is showing every invoice line's disposition, not just the ones that matched
 * cleanly. `purchaseOrderLineId`/`goodsReceiptLineId`/`productId` are all nullable for exactly
 * that reason — I7 applies here at the structural level: "no match found" is a real, recordable
 * fact, never silently dropped.
 *
 * `invoiceQuantity`/`invoiceUnitPrice` are the raw parsed values FROM THE EXTRACTION (never
 * re-derived from the PO/receipt) — the whole point of the match is comparing what was billed
 * against what was ordered/received, so this table must hold the invoice's own numbers
 * independently. `varianceType`/`varianceSeverity` are the computed classification
 * (packages/domain, a pure function) — persisted rather than recomputed on every read, matching
 * `stock_count_lines`' own "freeze the computed number, don't re-derive live" precedent, since the
 * PO/receipt/invoice inputs this was computed from could themselves change after the fact (a
 * later correction) and the match result should reflect what was true AT MATCH TIME.
 */
export const invoiceMatchLines = pgTable('invoice_match_lines', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  invoiceMatchId: uuid('invoice_match_id')
    .notNull()
    .references(() => invoiceMatches.id),
  invoiceLineIndex: numeric('invoice_line_index', { precision: 10, scale: 0 }).notNull(),

  purchaseOrderLineId: uuid('purchase_order_line_id').references(() => purchaseOrderLines.id),
  goodsReceiptLineId: uuid('goods_receipt_line_id').references(() => goodsReceiptLines.id),
  productId: uuid('product_id').references(() => products.id),

  invoiceSku: text('invoice_sku'),
  invoiceQuantity: numeric('invoice_quantity', { precision: 19, scale: 6 }),
  invoiceUnitPrice: numeric('invoice_unit_price', { precision: 19, scale: 4 }),

  poUnitPrice: numeric('po_unit_price', { precision: 19, scale: 4 }),
  receivedQuantity: numeric('received_quantity', { precision: 19, scale: 6 }),

  priceVariance: numeric('price_variance', { precision: 19, scale: 4 }),
  quantityVariance: numeric('quantity_variance', { precision: 19, scale: 6 }),

  varianceType: text('variance_type').notNull(),
  varianceSeverity: text('variance_severity').notNull(),
  explanation: text('explanation').notNull(),

  ...timestamps,
});

/** Matches plan.md's Phase 4 variance table exactly, plus `CLEAN` for a line with no variance at all — the common case, still recorded, never omitted (a match with zero lines would look like matching failed rather than succeeded). */
export const varianceTypeEnum = [
  'CLEAN',
  'PRICE_VARIANCE',
  'QUANTITY_VARIANCE',
  'UNORDERED_ITEM',
  'INVOICED_NOT_RECEIVED',
] as const;
export type VarianceType = (typeof varianceTypeEnum)[number];

/** `HIGH` is reserved for `INVOICED_NOT_RECEIVED` per plan.md's explicit "possible fraud/error" framing — every other variance type is at most `MEDIUM`. `NONE` for `CLEAN` lines. */
export const varianceSeverityEnum = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type VarianceSeverity = (typeof varianceSeverityEnum)[number];

export const invoiceMatchStatusEnum = ['PENDING', 'REVIEWED', 'RESOLVED'] as const;
export type InvoiceMatchStatus = (typeof invoiceMatchStatusEnum)[number];
