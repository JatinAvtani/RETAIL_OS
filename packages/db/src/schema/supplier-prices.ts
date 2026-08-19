import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { supplierProducts } from './supplier-products';
import { idColumn, timestamps } from './columns';

/**
 * the design — effective-dated price history per SupplierProduct, sourced from invoices and
 * quotes, NEVER overwritten. Correcting a wrongly-entered price means closing the bad row
 * (setting its validTo) and inserting a new one, the same append-preferred discipline as
 * stock_movements (I3), applied here to cost history instead of stock quantity.
 *
 * No `organizationId` column of its own — a supplier price only means anything in the context of
 * its `supplierProductId`, which is already tenant-scoped, so RLS here is a subquery through
 * supplier_products → suppliers, the same shape as product_variants' policy.
 *
 * `validTo` is nullable — NULL means "still in effect." The exclusion constraint (added in the
 * migration, not expressible through Drizzle's schema builder) uses `tstzrange(valid_from,
 * valid_to)` with an unbounded upper bound when `valid_to IS NULL`, which Postgres range types
 * handle natively.
 */
export const supplierPrices = pgTable('supplier_prices', {
  id: idColumn(),
  supplierProductId: uuid('supplier_product_id')
    .notNull()
    .references(() => supplierProducts.id),
  unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
  currency: text('currency').notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  sourceDocumentId: uuid('source_document_id'),
  ...timestamps,
});
