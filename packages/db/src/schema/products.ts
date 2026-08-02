import { boolean, integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { categories } from './categories';
import { units } from './units';
import { storageLocations } from './storage-locations';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

/**
 * Generalises across verticals with the same machinery: LOT for food expiry (FEFO allocation),
 * SERIAL for electronics/equipment, NONE for anything untracked at the unit level.
 */
export const productTrackingPolicyEnum = pgEnum('product_tracking_policy', ['NONE', 'LOT', 'SERIAL']);

/**
 * One Product entity for both purchased ingredients and sellable goods (spec 07 §7.3) —
 * deliberate: a café buys and sells the same bottle of juice, and splitting "ingredient" from
 * "product" creates constant reconciliation between two records of the same physical thing.
 * `type` is the boolean-flag-equivalent distinction the spec calls for, expressed as an enum since
 * a product can legitimately be both (an ingredient the café also sells retail).
 */
export const productTypeEnum = pgEnum('product_type', ['INGREDIENT', 'SELLABLE', 'BOTH']);

/**
 * `baseUnitId` is the unit every stock/recipe/costing calculation for this product is expressed in
 * internally — the "boundary" `resolveQuantity` (packages/domain) converts into. Case sizing,
 * recipe consumption units, etc. all convert to/from this one unit via `unit_conversions`, never
 * directly between each other (I6).
 *
 * `storageLocationId` now has its real FK to `storage_locations.id` (004-13) — the
 * expand-contract "contract" step, same shape as `unit_conversions.productId` gaining its FK
 * once `products` existed.
 */
export const products = pgTable('products', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  categoryId: uuid('category_id').references(() => categories.id),
  baseUnitId: uuid('base_unit_id')
    .notNull()
    .references(() => units.id),
  trackingPolicy: productTrackingPolicyEnum('tracking_policy').notNull().default('NONE'),
  isPerishable: boolean('is_perishable').notNull().default(false),
  defaultShelfLifeDays: integer('default_shelf_life_days'),
  storageLocationId: uuid('storage_location_id').references(() => storageLocations.id),
  // Stores the object's storage KEY (packages/storage), never a URL — spec 14 §14.5 objects are
  // never public; every read goes through a short-lived presigned URL generated on demand.
  imageKey: text('image_key'),
  type: productTypeEnum('type').notNull(),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});

/**
 * Size/color/pack variations of a product (spec 07 §7.3). Every product gets a default variant on
 * creation (enforced in the repository layer, not the schema — see ProductRepository.create) so
 * food service, which barely uses this dimension, never has to see it: exactly one variant with
 * `isDefault = true` and the product's own name. Fashion/grocery/electronics get the same table
 * with real variant rows, with zero schema migration needed later.
 */
export const productVariants = pgTable('product_variants', {
  id: idColumn(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  name: text('name').notNull(),
  sku: text('sku'),
  barcode: text('barcode'),
  attributes: jsonb('attributes'),
  isDefault: boolean('is_default').notNull().default(false),
  ...timestamps,
  ...softDelete,
});
