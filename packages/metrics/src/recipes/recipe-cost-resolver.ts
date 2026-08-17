import { Decimal } from 'decimal.js';
import {
  ProductRepository,
  RecipeRepository,
  SupplierPriceRepository,
  SupplierProductRepository,
  UnitConversionRepository,
  UnitRepository,
  type createDb,
} from '@retailos/db';
import {
  explodeRecipe,
  money,
  quantity,
  resolveQuantity,
  RecipeDepthExceededError,
  RecipeVersionNotFoundError,
  type CurrencyCode,
  type Money,
  type Recipe,
  type RecipeComponent,
  type RecipeResolver,
  type Unit,
} from '@retailos/domain';
import { computeRecipeCost, type RecipeCostLine } from './recipe-cost.js';

type Db = ReturnType<typeof createDb>['db'];

/**
 * The REAL, production recipe-cost resolver (009-01) — moved here from
 * `apps/api/src/metrics/recipe-cost-resolver.ts` so BOTH `apps/api` (the dashboard's own injected
 * `resolveRecipeUnitCost`) and `apps/worker` (the fact-aggregation job's real theoretical-COGS
 * need) can share the identical implementation, rather than each app maintaining its own copy —
 * confirmed with the user over stubbing theoretical COGS as permanently unknown in the worker
 * context, since two real consumers needing the same recipe-resolution logic is exactly the
 * situation I2 exists to prevent from drifting into two independently-maintained formulas.
 *
 * Recipe cost resolution is genuinely involved — recursive explosion, per-ingredient supplier
 * price lookup, cheapest-confirmed-price selection, and unit conversion into the unit the price is
 * expressed in. Division of responsibility unchanged from the original: this module RESOLVES
 * inputs (lookup, conversion, choosing a price) and hands them to `computeRecipeCost` (this same
 * package), which is the only place they are summed.
 *
 * The one real change from the `apps/api` original: `RecipeNotFoundError`/`RecipeResolutionError`
 * (plain `Error` subclasses) replace `TRPCError` throws — `packages/metrics` has no dependency on
 * `@trpc/server` and must not gain one just for this; `apps/api`'s own call site is responsible for
 * catching these and mapping them to its own `TRPCError` shape at its own boundary, matching every
 * other packages/metrics function's "throws plain errors, the HTTP layer translates them" contract.
 */

export class RecipeNotFoundError extends Error {
  constructor(recipeGroupId: string) {
    super(`Recipe '${recipeGroupId}' not found.`);
    this.name = 'RecipeNotFoundError';
  }
}

/**
 * Recursively loads every recipe version reachable from `recipeGroupId` into `preloaded` — a plain
 * per-call local `Map`, never a persistent/shared cache, so there is no cross-tenant collision
 * surface: it is garbage collected the moment the calling request/job finishes. Named `preloaded`
 * rather than `cache` to keep that legible.
 *
 * `explodeRecipe` is pure/no-I/O by design, so every row it might need must be fetched BEFORE
 * calling it, not lazily during recursion. Depth-bounded as defense in depth; the repository's
 * save-time DFS remains the primary cycle guard.
 */
export const preloadRecipeTree = async (
  recipeRepository: RecipeRepository,
  unitCodeById: Map<string, Unit>,
  preloaded: Map<string, Recipe | null>,
  recipeGroupId: string,
  asOf: Date,
  depth = 0
): Promise<void> => {
  if (depth > 10) return;
  const recipeKey = `${recipeGroupId}::${asOf.toISOString()}`;
  if (preloaded.has(recipeKey)) return;

  const version = await recipeRepository.findVersionAsOf(recipeGroupId, asOf);
  if (!version) {
    preloaded.set(recipeKey, null);
    return;
  }

  const componentRows = await recipeRepository.findComponents(version.id);
  const components: RecipeComponent[] = componentRows.map((row): RecipeComponent => {
    const unit = unitCodeById.get(row.unitId);
    if (!unit) {
      throw new Error(`Unknown unit id '${row.unitId}' on a recipe component.`);
    }
    return row.componentType === 'PRODUCT'
      ? {
          componentType: 'PRODUCT',
          productId: row.productId!,
          quantity: new Decimal(row.quantity),
          unit,
          wasteFactor: new Decimal(row.wasteFactor),
        }
      : {
          componentType: 'RECIPE',
          subRecipeGroupId: row.subRecipeGroupId!,
          quantity: new Decimal(row.quantity),
          unit,
          wasteFactor: new Decimal(row.wasteFactor),
        };
  });

  const yieldUnit = unitCodeById.get(version.yieldUnitId);
  if (!yieldUnit) {
    throw new Error(`Unknown yield unit id '${version.yieldUnitId}' on a recipe.`);
  }

  preloaded.set(recipeKey, {
    recipeGroupId: version.recipeGroupId,
    yieldQuantity: new Decimal(version.yieldQuantity),
    yieldUnit,
    components,
  });

  for (const row of componentRows) {
    if (row.componentType === 'RECIPE' && row.subRecipeGroupId) {
      await preloadRecipeTree(recipeRepository, unitCodeById, preloaded, row.subRecipeGroupId, asOf, depth + 1);
    }
  }
};

/**
 * Full cost breakdown for one recipe group, as of now. Throws `RecipeNotFoundError` for a missing
 * recipe, or a plain `Error` for a malformed component/yield unit — the caller (an `apps/api`
 * router, the fact-aggregation job) maps these to its own boundary's error shape.
 */
export const resolveRecipeCostBreakdown = async (db: Db, organizationId: string, recipeGroupId: string, currency: CurrencyCode) => {
  const recipeRepository = new RecipeRepository(db, organizationId);
  const productRepository = new ProductRepository(db, organizationId);
  const supplierProductRepository = new SupplierProductRepository(db, organizationId);
  const supplierPriceRepository = new SupplierPriceRepository(db, organizationId);
  const unitConversionRepository = new UnitConversionRepository(db, organizationId);
  const unitRepository = new UnitRepository(db);

  const allUnits = await unitRepository.findAll();
  const unitCodeById = new Map(allUnits.map((u) => [u.id, u.code as Unit]));
  const unitIdByCode = new Map(allUnits.map((u) => [u.code, u.id]));

  const asOf = new Date();
  const preloaded = new Map<string, Recipe | null>();
  await preloadRecipeTree(recipeRepository, unitCodeById, preloaded, recipeGroupId, asOf);

  const rootRecipe = preloaded.get(`${recipeGroupId}::${asOf.toISOString()}`);
  if (!rootRecipe) {
    throw new RecipeNotFoundError(recipeGroupId);
  }

  const resolver: RecipeResolver = (groupId, forAsOf) => preloaded.get(`${groupId}::${forAsOf.toISOString()}`) ?? null;

  let exploded;
  try {
    exploded = explodeRecipe(rootRecipe, quantity(rootRecipe.yieldQuantity, rootRecipe.yieldUnit), asOf, resolver);
  } catch (err) {
    if (err instanceof RecipeDepthExceededError || err instanceof RecipeVersionNotFoundError) {
      throw err;
    }
    throw err;
  }

  const lines: RecipeCostLine[] = [];
  for (const ingredient of exploded) {
    const confirmedMappings = await supplierProductRepository.findConfirmedForProduct(ingredient.productId);
    const withCurrentPrice = (
      await Promise.all(
        confirmedMappings.map(async (mapping) => ({
          mapping,
          price: await supplierPriceRepository.findCurrent(mapping.id),
        }))
      )
    ).filter(
      (
        entry
      ): entry is {
        mapping: (typeof confirmedMappings)[number];
        price: NonNullable<Awaited<ReturnType<typeof supplierPriceRepository.findCurrent>>>;
      } => entry.price !== null && entry.price.currency === currency && entry.mapping.conversionToBase !== null && entry.mapping.packUnitId !== null
    );

    if (withCurrentPrice.length === 0) {
      lines.push({ productId: ingredient.productId, cost: 'unknown' });
      continue;
    }

    const cheapest = withCurrentPrice.reduce((min, entry) => (Number(entry.price.unitPrice) < Number(min.price.unitPrice) ? entry : min));

    const product = await productRepository.findById(ingredient.productId);
    const ingredientUnitId = unitIdByCode.get(ingredient.unit);
    if (!product || !ingredientUnitId) {
      lines.push({ productId: ingredient.productId, cost: 'unknown' });
      continue;
    }
    const baseUnitCode = unitCodeById.get(product.baseUnitId);
    if (!baseUnitCode) {
      lines.push({ productId: ingredient.productId, cost: 'unknown' });
      continue;
    }

    try {
      const factorRow = await unitConversionRepository.findFactor(ingredientUnitId, product.baseUnitId, ingredient.productId);
      const conversionTable = factorRow
        ? [{ fromUnitId: ingredientUnitId, toUnitId: product.baseUnitId, productId: factorRow.productId, factor: factorRow.factor }]
        : [];

      const qtyInBaseUnit = resolveQuantity(
        quantity(ingredient.quantity, ingredient.unit),
        baseUnitCode,
        ingredientUnitId,
        product.baseUnitId,
        conversionTable,
        ingredient.productId
      );

      const conversionToBase = cheapest.mapping.conversionToBase!;
      const lineCost = money(qtyInBaseUnit.amount.times(cheapest.price.unitPrice).dividedBy(conversionToBase), currency);
      lines.push({ productId: ingredient.productId, cost: lineCost });
    } catch {
      lines.push({ productId: ingredient.productId, cost: 'unknown' });
    }
  }

  return computeRecipeCost(lines, currency);
};

/**
 * The cost of ONE unit of a recipe's output. `resolveRecipeCostBreakdown` returns the cost of a
 * whole BATCH; dividing by `yieldQuantity` is the difference between a plausible-looking number and
 * a correct one (see `retailos-recipe-cost-is-per-batch` project memory). A recipe whose cost can't
 * be fully resolved, or has no real version as of now, returns `'unknown'` rather than throwing —
 * this is the one function in this file callers treat as a soft failure (a menu item with an
 * unresolvable recipe should not blank an entire dashboard/fact row), matching the original
 * `apps/api` resolver's exact same contract.
 */
export const resolveRecipeUnitCost = async (
  db: Db,
  organizationId: string,
  recipeRepository: RecipeRepository,
  recipeGroupId: string,
  currency: CurrencyCode
): Promise<Money | 'unknown'> => {
  try {
    const batch = await resolveRecipeCostBreakdown(db, organizationId, recipeGroupId, currency);
    if (batch.total === 'unknown') return 'unknown';

    const version = await recipeRepository.findVersionAsOf(recipeGroupId, new Date());
    if (!version) return 'unknown';

    const yieldQuantity = new Decimal(version.yieldQuantity);
    if (yieldQuantity.lessThanOrEqualTo(0)) return 'unknown';

    return money(batch.total.amount.dividedBy(yieldQuantity), currency);
  } catch {
    return 'unknown';
  }
};
