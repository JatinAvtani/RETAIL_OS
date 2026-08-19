import { boolean, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { suppliers } from './suppliers';
import { products, productVariants } from './products';
import { units } from './units';
import { idColumn, timestamps } from './columns';

/**
 * the design — "the unglamorous linchpin of the whole system": supplier "FLR-00123 / Flour
 * T55 25kg sack" resolves to our product "Flour, T55" with a 25kg conversion. This table IS that
 * resolution, stored permanently once confirmed.
 *
 * `conversionToBase` is the product-specific factor from the supplier's pack size to the
 * product's base unit (e.g. 1 sack = 25 kg) — the exact shape `unit_conversions` already models
 * with a non-null `productId`. This column does NOT duplicate that table; it's the pack-size fact
 * as this specific supplier-product mapping records it, which a confirmation flow writes into
 * `unit_conversions` as the real product-specific conversion row. Kept here too because a
 * mapping's pack size is intrinsic to what a supplier SKU means, independent of whether a
 * conversion row has been separately created yet.
 *
 * `isConfirmed` — the design's fuzzy-match flow only ever *suggests* a mapping; a human
 * confirming it is what makes `isConfirmed = true` and the row permanent. A wrong auto-mapping
 * corrupts cost data for months, so nothing reads cost through an unconfirmed row (enforced by
 * the repository layer, not a DB constraint — see SupplierProductRepository).
 */
export const supplierProducts = pgTable('supplier_products', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => suppliers.id),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  variantId: uuid('variant_id').references(() => productVariants.id),
  supplierSku: text('supplier_sku').notNull(),
  supplierDescription: text('supplier_description'),
  packSize: numeric('pack_size', { precision: 19, scale: 6 }),
  packUnitId: uuid('pack_unit_id').references(() => units.id),
  conversionToBase: numeric('conversion_to_base', { precision: 19, scale: 9 }),
  isConfirmed: boolean('is_confirmed').notNull().default(false),
  ...timestamps,
});
