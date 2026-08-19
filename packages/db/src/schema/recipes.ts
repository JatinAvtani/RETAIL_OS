import { numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { units } from './units';
import { products } from './products';
import { idColumn, timestamps } from './columns';

export const recipeComponentTypeEnum = pgEnum('recipe_component_type', ['PRODUCT', 'RECIPE']);

/**
 * the design: "Recipes are versioned — recipes change, and historical margin must be computed
 * against the recipe in effect at the time." Same effective-dating shape as `supplier_prices`
 *: `recipeGroupId`
 * is the STABLE identity that survives across versions (what `menu_items.recipe_id` and
 * `recipe_components.sub_recipe_id` point at); `id` identifies one specific version row.
 * `EXCLUDE USING gist (recipe_group_id WITH =, tstzrange(valid_from, valid_to) WITH &&)` (added in
 * the migration) makes "two versions of the same recipe with overlapping validity" a hard database
 * error, exactly like supplier_prices' overlapping-price-period constraint.
 *
 * `yieldQuantity`/`yieldUnitId` — what one batch of this recipe produces. Explosion
 * (packages/domain/src/recipes/explode.ts) scales every component by `requestedQty / yieldQuantity`.
 */
export const recipes = pgTable('recipes', {
  id: idColumn(),
  recipeGroupId: uuid('recipe_group_id').notNull(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  name: text('name').notNull(),
  yieldQuantity: numeric('yield_quantity', { precision: 19, scale: 6 }).notNull(),
  yieldUnitId: uuid('yield_unit_id')
    .notNull()
    .references(() => units.id),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  ...timestamps,
});

/**
 * A component references EITHER a `Product` OR another `Recipe` (`componentType` discriminates
 * which of `productId`/`subRecipeId` is populated) — this is what makes recursive explosion
 * possible: a sauce recipe can be a component of a dish recipe.
 *
 * `subRecipeGroupId` references `recipes.recipe_group_id`, the STABLE identity — the same
 * reasoning as `menu_items.recipe_id`: a component should track "this recipe" across its version
 * history, resolving to the version valid `asOf` explosion time, not permanently pinning to
 * whatever version existed when the component was added. No FK here (unlike `productId`):
 * `recipe_group_id` is deliberately NOT unique (every version row shares it), and Postgres FKs can
 * only target a unique/PK column — referential integrity for this column is enforced in
 * `RecipeRepository`, which resolves it against a real query before ever writing a row.
 *
 * `wasteFactor` — a multiplier applied on top of the raw quantity (e.g. 1.05 for 5% trim loss).
 * Per the plan's property-test list: waste factor increases quantity, never decreases, so this is
 * constrained to be >= 1 at the domain layer (packages/domain), not the database — the constraint
 * is about business meaning, not a value range integrity check.
 *
 * Cycle detection (component graph must be acyclic, the design) happens at save time in
 * RecipeRepository via a real DFS over `sub_recipe_id` edges, not here — a database CHECK
 * constraint cannot express "no cycle in a self-referencing graph across rows."
 */
export const recipeComponents = pgTable('recipe_components', {
  id: idColumn(),
  recipeId: uuid('recipe_id')
    .notNull()
    .references(() => recipes.id),
  componentType: recipeComponentTypeEnum('component_type').notNull(),
  productId: uuid('product_id').references(() => products.id),
  subRecipeGroupId: uuid('sub_recipe_group_id'),
  quantity: numeric('quantity', { precision: 19, scale: 6 }).notNull(),
  unitId: uuid('unit_id')
    .notNull()
    .references(() => units.id),
  wasteFactor: numeric('waste_factor', { precision: 6, scale: 4 }).notNull().default('1.0000'),
  ...timestamps,
});

/**
 * the design: the sellable unit, distinct from Product — "a menu item is a presentation and
 * pricing concept ('Large Latte, $4.50, happy-hour $3.50') while a product is a physical concept."
 * `recipeId` references `recipes.recipe_group_id` (the stable identity, same reasoning as
 * `recipe_components.subRecipeGroupId`) — a menu item always resolves to whichever recipe version
 * is valid `asOf` the sale being costed, not a version pinned at menu-item-creation time.
 */
export const menuItems = pgTable('menu_items', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  name: text('name').notNull(),
  recipeGroupId: uuid('recipe_group_id').notNull(),
  price: numeric('price', { precision: 19, scale: 4 }).notNull(),
  priceValidFrom: timestamp('price_valid_from', { withTimezone: true }).notNull(),
  ...timestamps,
});
