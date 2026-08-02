import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { menuItems } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * `menuItems` IS directly tenant-scoped (real `organization_id` column, unlike
 * `recipe_components`/`supplier_prices`), so this extends `TenantScopedRepository` normally.
 * `recipeGroupId` deliberately has no FK (spec 07 SS7.3: MenuItem is distinct from Product/Recipe
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
