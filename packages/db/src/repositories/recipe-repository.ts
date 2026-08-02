import { and, eq, isNull, lte, or, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { recipeComponents, recipes } from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';
import { generateId } from '@retailos/domain';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type RecipeComponentInput = {
  componentType: 'PRODUCT' | 'RECIPE';
  productId?: string;
  subRecipeGroupId?: string;
  quantity: string;
  unitId: string;
  wasteFactor?: string;
};

export class RecipeCycleError extends Error {
  constructor(public readonly recipeGroupId: string, public readonly cyclePath: string[]) {
    super(
      `Saving this recipe would create a cycle: ${[...cyclePath, recipeGroupId].join(' -> ')}. ` +
        'The component graph must be acyclic (spec 07 SS7.3).'
    );
    this.name = 'RecipeCycleError';
  }
}

/**
 * `recipes` is effective-dated (a stable `recipeGroupId` across version rows, spec 08 SS8.4's
 * exclusion-constraint pattern, identical mechanism to `SupplierPriceRepository`) — this
 * repository does NOT extend `TenantScopedRepository` for the same reason
 * `SupplierPriceRepository` doesn't: `recipe_components` has no `organization_id` of its own, so
 * its RLS policy is subquery-based, and the base class's direct-column WHERE-ANDing has nothing to
 * AND against on that table. `withTenantContext` is called explicitly instead.
 */
export class RecipeRepository {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('RecipeRepository constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  private async runScoped<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
    return this.db.transaction((tx) => withTenantContext(tx, this.organizationId, () => fn(tx)));
  }

  /** The version of `recipeGroupId` valid at `asOf`, or null if none exists. */
  async findVersionAsOf(recipeGroupId: string, asOf: Date) {
    const rows = await this.runScoped((tx) =>
      tx
        .select()
        .from(recipes)
        .where(
          and(
            eq(recipes.recipeGroupId, recipeGroupId),
            lte(recipes.validFrom, asOf),
            or(isNull(recipes.validTo), gt(recipes.validTo, asOf))
          )
        )
    );
    return rows[0] ?? null;
  }

  async findComponents(recipeId: string) {
    return this.runScoped((tx) => tx.select().from(recipeComponents).where(eq(recipeComponents.recipeId, recipeId)));
  }

  /**
   * Cycle detection at save time (spec 07 SS7.3: "the component graph must be acyclic, validated
   * on write" — plan.md: "discovering a cycle when a customer views a margin report is far too
   * late"). Real DFS over `sub_recipe_group_id` edges, following each visited sub-recipe's
   * CURRENTLY-VALID (asOf now) component set — walking every historical version would reject
   * perfectly valid new recipes based on a past version's shape that no longer applies.
   *
   * `targetGroupId` is the recipe group being created/versioned; a cycle exists if DFS starting
   * from `newComponents`' sub-recipe edges ever reaches back to it.
   */
  private async detectCycle(
    tx: Tx,
    targetGroupId: string,
    newComponents: RecipeComponentInput[],
    asOf: Date
  ): Promise<void> {
    const visiting = new Set<string>();
    const path: string[] = [];

    const visit = async (groupId: string): Promise<void> => {
      if (groupId === targetGroupId) {
        throw new RecipeCycleError(targetGroupId, [...path]);
      }
      if (visiting.has(groupId)) {
        return; // Already fully explored this branch with no cycle found — don't re-walk it.
      }
      visiting.add(groupId);
      path.push(groupId);

      const versionRows = await tx
        .select()
        .from(recipes)
        .where(
          and(
            eq(recipes.recipeGroupId, groupId),
            lte(recipes.validFrom, asOf),
            or(isNull(recipes.validTo), gt(recipes.validTo, asOf))
          )
        );
      const version = versionRows[0];
      if (version) {
        const components = await tx.select().from(recipeComponents).where(eq(recipeComponents.recipeId, version.id));
        for (const component of components) {
          if (component.componentType === 'RECIPE' && component.subRecipeGroupId) {
            await visit(component.subRecipeGroupId);
          }
        }
      }
      path.pop();
    };

    for (const component of newComponents) {
      if (component.componentType === 'RECIPE' && component.subRecipeGroupId) {
        await visit(component.subRecipeGroupId);
      }
    }
  }

  /**
   * Creates a new recipe version (and its components) in one transaction. `recipeGroupId` is
   * required from the caller — a genuinely new recipe passes a freshly generated id; a new
   * VERSION of an existing recipe passes the existing group's id, and the exclusion constraint
   * (recipes_no_overlapping_versions) is the hard backstop if this repository's own validity-range
   * logic is ever wrong. Cycle detection runs BEFORE any row is written — a rejected save leaves
   * the database untouched, never a half-written recipe.
   */
  async create(input: {
    id: string;
    recipeGroupId: string;
    name: string;
    yieldQuantity: string;
    yieldUnitId: string;
    validFrom: Date;
    components: RecipeComponentInput[];
  }) {
    return this.runScoped(async (tx) => {
      await this.detectCycle(tx, input.recipeGroupId, input.components, input.validFrom);

      const insertedRecipes = await tx
        .insert(recipes)
        .values({
          id: input.id,
          recipeGroupId: input.recipeGroupId,
          organizationId: this.organizationId,
          name: input.name,
          yieldQuantity: input.yieldQuantity,
          yieldUnitId: input.yieldUnitId,
          validFrom: input.validFrom,
        })
        .returning();
      const recipe = insertedRecipes[0];
      if (!recipe) {
        throw new Error('Recipe insert returned no row.');
      }

      for (const component of input.components) {
        await tx.insert(recipeComponents).values({
          id: generateId(),
          recipeId: recipe.id,
          componentType: component.componentType,
          productId: component.productId ?? null,
          subRecipeGroupId: component.subRecipeGroupId ?? null,
          quantity: component.quantity,
          unitId: component.unitId,
          wasteFactor: component.wasteFactor ?? '1.0000',
        });
      }

      return recipe;
    });
  }

  /**
   * A new VERSION of an existing recipe group — same append-preferred discipline as
   * `SupplierPriceRepository.recordNewPrice`: closes the currently-open version (`validTo` = new
   * version's `validFrom`) and inserts a fresh one with its own components, in one transaction.
   * Never mutates an existing version's components in place — that would silently rewrite history
   * a past margin calculation already depended on.
   */
  async createNewVersion(input: {
    id: string;
    recipeGroupId: string;
    name: string;
    yieldQuantity: string;
    yieldUnitId: string;
    validFrom: Date;
    components: RecipeComponentInput[];
  }) {
    return this.runScoped(async (tx) => {
      await this.detectCycle(tx, input.recipeGroupId, input.components, input.validFrom);

      const current = await tx
        .select()
        .from(recipes)
        .where(and(eq(recipes.recipeGroupId, input.recipeGroupId), isNull(recipes.validTo)));
      if (current[0]) {
        await tx.update(recipes).set({ validTo: input.validFrom }).where(eq(recipes.id, current[0].id));
      }

      const insertedRecipes = await tx
        .insert(recipes)
        .values({
          id: input.id,
          recipeGroupId: input.recipeGroupId,
          organizationId: this.organizationId,
          name: input.name,
          yieldQuantity: input.yieldQuantity,
          yieldUnitId: input.yieldUnitId,
          validFrom: input.validFrom,
        })
        .returning();
      const recipe = insertedRecipes[0];
      if (!recipe) {
        throw new Error('Recipe insert returned no row.');
      }

      for (const component of input.components) {
        await tx.insert(recipeComponents).values({
          id: generateId(),
          recipeId: recipe.id,
          componentType: component.componentType,
          productId: component.productId ?? null,
          subRecipeGroupId: component.subRecipeGroupId ?? null,
          quantity: component.quantity,
          unitId: component.unitId,
          wasteFactor: component.wasteFactor ?? '1.0000',
        });
      }

      return recipe;
    });
  }
}
