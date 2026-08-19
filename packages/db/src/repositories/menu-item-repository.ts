import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { menuItems } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * `menuItems` IS directly tenant-scoped (real `organization_id` column, unlike
 * `recipe_components`/`supplier_prices`), so this extends `TenantScopedRepository` normally.
 * `recipeGroupId` deliberately has no FK (the design: MenuItem is distinct from Product/Recipe
 * on purpose — see `recipes.ts`'s schema comment for why `recipe_group_id` can't be an FK target).
 */
export class MenuItemRepository extends TenantScopedRepository<typeof menuItems> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, menuItems, organizationId);
  }

  async findAll() {
    return this.runScoped((db, scopedWhere) => db.select().from(menuItems).where(scopedWhere()));
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(menuItems)
        .where(scopedWhere(eq(menuItems.id, id)))
    );
    return rows[0] ?? null;
  }

  async findByRecipeGroup(recipeGroupId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(menuItems)
        .where(scopedWhere(eq(menuItems.recipeGroupId, recipeGroupId)))
    );
  }

  /**
   * `menu_items_without_recipe`'s real input. `recipeGroupId` is `NOT NULL` on `menuItems` but has
   * deliberately no FK (see this file's header comment), so "no recipe" can never mean
   * `recipeGroupId IS NULL` — it means no `recipes` row with that `recipeGroupId` is currently
   * valid (`validFrom <= asOf AND (validTo IS NULL OR validTo > asOf)`), the same "current version"
   * definition `RecipeRepository.findVersionAsOf` already uses. `recipes` is queried directly
   * (raw SQL, not `RecipeRepository`) since this needs a `NOT EXISTS` correlated to every menu item
   * at once, not a per-recipeGroupId lookup.
   */
  async findWithoutValidRecipe(asOf: Date = new Date()) {
    const asOfIso = asOf.toISOString();
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(menuItems)
        .where(
          scopedWhere(
            sql`NOT EXISTS (
              SELECT 1 FROM recipes r
              WHERE r.recipe_group_id = ${menuItems.recipeGroupId}
                AND r.organization_id = ${this.organizationId}
                AND r.valid_from <= ${asOfIso}::timestamptz
                AND (r.valid_to IS NULL OR r.valid_to > ${asOfIso}::timestamptz)
            )`
          )
        )
    );
  }

  async create(input: { id: string; name: string; recipeGroupId: string; price: string; priceValidFrom: Date }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(menuItems)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          name: input.name,
          recipeGroupId: input.recipeGroupId,
          price: input.price,
          priceValidFrom: input.priceValidFrom,
        })
        .returning()
    );
    const created = rows[0];
    if (!created) {
      throw new Error('Menu item insert returned no row.');
    }
    return created;
  }
}
