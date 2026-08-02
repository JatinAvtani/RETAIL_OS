import { Decimal } from 'decimal.js';
import type { Unit } from '../primitives/unit.js';
import type { Quantity } from '../primitives/quantity.js';
import { quantity } from '../primitives/quantity.js';

/** A leaf component: consumes a real product. */
export type ProductComponent = {
  componentType: 'PRODUCT';
  productId: string;
  quantity: Decimal;
  unit: Unit;
  wasteFactor: Decimal;
};

/** A recursive component: consumes another recipe (by its stable group id, not a specific version). */
export type SubRecipeComponent = {
  componentType: 'RECIPE';
  subRecipeGroupId: string;
  quantity: Decimal;
  unit: Unit;
  wasteFactor: Decimal;
};

export type RecipeComponent = ProductComponent | SubRecipeComponent;

/** One effective-dated version of a recipe — exactly the shape explosion needs, nothing DB-specific. */
export type Recipe = {
  recipeGroupId: string;
  yieldQuantity: Decimal;
  yieldUnit: Unit;
  components: RecipeComponent[];
};

export type ExplodedIngredient = {
  productId: string;
  quantity: Decimal;
  unit: Unit;
};

/**
 * Resolves the recipe VERSION valid at `asOf` for a given stable `recipeGroupId` — the caller
 * supplies this (a real implementation queries `recipes` filtered to
 * `valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf)`), keeping this module pure and
 * testable without a database, per CLAUDE.md's domain-logic discipline. Returns `null` when no
 * version was valid at that date — explosion must fail loudly (I7), never silently skip a
 * sub-recipe.
 */
export type RecipeResolver = (recipeGroupId: string, asOf: Date) => Recipe | null;

export const MAX_RECIPE_DEPTH = 10;

export class RecipeDepthExceededError extends Error {
  constructor(depth: number) {
    super(`Recipe explosion exceeded maximum depth (${MAX_RECIPE_DEPTH}) at depth ${depth} — likely an undetected cycle.`);
    this.name = 'RecipeDepthExceededError';
  }
}

export class RecipeVersionNotFoundError extends Error {
  constructor(recipeGroupId: string, asOf: Date) {
    super(`No recipe version for '${recipeGroupId}' is valid as of ${asOf.toISOString()}.`);
    this.name = 'RecipeVersionNotFoundError';
  }
}

/**
 * Recursive, depth-limited recipe explosion (plan.md's Phase 4 core algorithm). Scales every
 * component by `requestedQty / recipe.yieldQuantity`, applies `wasteFactor` as a multiplier
 * (>= 1, enforced at the database layer too — see recipe_components' CHECK constraint), recurses
 * into sub-recipe components using the version of that sub-recipe valid `asOf` (so historical
 * explosion is reproducible even after a sub-recipe changes), and merges duplicate product lines
 * by summing quantities in the SAME unit only (cross-unit merging is a boundary-conversion
 * decision this function deliberately does not make — see the merge note below).
 *
 * Depth protects against a cycle that somehow reached this function despite save-time DFS
 * rejection (defense in depth, not the primary cycle guard — RecipeRepository's DFS is).
 */
export const explodeRecipe = (
  recipe: Recipe,
  requestedQty: Quantity<Unit>,
  asOf: Date,
  resolve: RecipeResolver,
  depth = 0
): ExplodedIngredient[] => {
  if (depth > MAX_RECIPE_DEPTH) {
    throw new RecipeDepthExceededError(depth);
  }
  if (requestedQty.unit !== recipe.yieldUnit) {
    throw new Error(
      `explodeRecipe requires requestedQty in the recipe's yield unit ('${recipe.yieldUnit}'), got '${requestedQty.unit}' — convert at the boundary before calling, never inside explosion (I6).`
    );
  }

  const scaleFactor = requestedQty.amount.dividedBy(recipe.yieldQuantity);
  const results: ExplodedIngredient[] = [];

  for (const component of recipe.components) {
    const scaledQty = component.quantity.times(scaleFactor).times(component.wasteFactor);

    if (component.componentType === 'PRODUCT') {
      results.push({ productId: component.productId, quantity: scaledQty, unit: component.unit });
      continue;
    }

    const subRecipe = resolve(component.subRecipeGroupId, asOf);
    if (!subRecipe) {
      throw new RecipeVersionNotFoundError(component.subRecipeGroupId, asOf);
    }
    const subExploded = explodeRecipe(
      subRecipe,
      quantity(scaledQty, component.unit),
      asOf,
      resolve,
      depth + 1
    );
    results.push(...subExploded);
  }

  return mergeByProductAndUnit(results);
};

/**
 * "Flour appearing in both a sauce sub-recipe and directly must sum, not appear twice" (plan.md).
 * Merging is scoped to (productId, unit) pairs deliberately, not productId alone — two exploded
 * lines for the same product in DIFFERENT units are a real signal that a unit-conversion boundary
 * was crossed somewhere upstream inconsistently, and silently summing across units here would be
 * exactly the implicit mid-calculation conversion I6 forbids. A future costing layer that needs a
 * single total per product converts explicitly at ITS boundary, using the real conversion table —
 * not by this function guessing which unit "wins."
 */
const mergeByProductAndUnit = (ingredients: ExplodedIngredient[]): ExplodedIngredient[] => {
  const merged = new Map<string, ExplodedIngredient>();
  for (const ingredient of ingredients) {
    const key = `${ingredient.productId}::${ingredient.unit}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing
        ? { ...existing, quantity: existing.quantity.plus(ingredient.quantity) }
        : ingredient
    );
  }
  return [...merged.values()];
};
