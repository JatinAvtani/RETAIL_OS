import { boolean, numeric, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { idColumn, timestamps } from './columns';

export const unitDimensionEnum = pgEnum('unit_dimension', ['MASS', 'VOLUME', 'COUNT']);

/**
 * Global lookup, not tenant-scoped — a unit like 'kg' or 'each' means the same thing for every
 * organization. `code` matches packages/domain's Unit union (mg/g/kg, ml/l, each) so the DB and
 * the branded-type layer never drift into two different vocabularies for the same concept.
 * `isBase` marks the one unit per dimension that packages/domain treats as canonical (g for MASS,
 * ml for VOLUME) — see MASS_BASE_UNIT/VOLUME_BASE_UNIT in packages/domain/src/primitives/unit.ts.
 */
export const units = pgTable('units', {
  id: idColumn(),
  code: text('code').notNull(),
  dimension: unitDimensionEnum('dimension').notNull(),
  isBase: boolean('is_base').notNull().default(false),
  ...timestamps,
});

/**
 * The conversion graph referenced by spec 07 §7.3 ("UnitOfMeasure & UnitConversion"). Two
 * fundamentally different kinds of row, distinguished by whether `productId` is set — conflating
 * them is exactly the bug this table exists to prevent (I6):
 *
 *  - `productId IS NULL` — a global, dimension-internal fact ("1 kg = 1000 g"). Immutable, true
 *    for every organization and every product. packages/domain's `convertQuantity` already
 *    implements this in pure code; rows here let the same facts be queried/audited from SQL and
 *    give product-specific conversions somewhere to fall back to.
 *  - `productId IS NOT NULL` — a product-specific fact ("1 case of this flour = 25 kg"). A "case"
 *    has no meaning without a product, so this conversion cannot live in the global set and must
 *    never be looked up without the product id.
 *
 * Resolution order (enforced in packages/domain, not here): product-specific row first, then the
 * global row, then fail loudly — never guess a factor. This table only stores the facts; it does
 * not decide how they're resolved.
 *
 * NUMERIC(19,9) — more decimal places than Money's NUMERIC(19,4) because a conversion factor
 * (e.g. grams per case) compounds through every downstream multiplication; rounding it early
 * would introduce drift that grows with recipe/order volume.
 */
export const unitConversions = pgTable('unit_conversions', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  fromUnitId: uuid('from_unit_id')
    .notNull()
    .references(() => units.id),
  toUnitId: uuid('to_unit_id')
    .notNull()
    .references(() => units.id),
  // The real FK to products.id exists at the database level (added in
  // 0009_categories_products.sql's "contract" step, once products exists), but is deliberately
  // NOT declared here via `.references()` — doing so would create a schema-file import cycle
  // (products.ts needs units for baseUnitId; units.ts would need products for this FK). Module
  // boundaries (dependency-cruiser) reject that cycle even though it happens to work at runtime.
  // The real constraint still exists in Postgres; it's just not mirrored in Drizzle's type layer.
  productId: uuid('product_id'),
  factor: numeric('factor', { precision: 19, scale: 9 }).notNull(),
  ...timestamps,
});
