import { TRPCError } from '@trpc/server';
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
import { computeRecipeCost, type RecipeCostLine } from '@retailos/metrics';

type Db = ReturnType<typeof createDb>['db'];

/**
 * Resolving a recipe's cost is genuinely involved — recursive explosion, per-ingredient supplier
 * price lookup, cheapest-confirmed-price selection, and unit conversion into the unit the price is
 * expressed in. It lives here, shared, rather than inside one router, because two callers now need
 * it (the recipe detail page and the dashboard's theoretical COGS). Two copies of this logic would
 * eventually disagree, and a recipe costing $1.25 on one screen and $1.27 on another destroys
 * confidence in every number the product shows.
 *
 * Note the division of responsibility: this module RESOLVES inputs (lookup, conversion, choosing
 * a price) and hands them to `computeRecipeCost` in the metric catalog, which is the only place
 * they are summed.
 */

/**
 * Recursively loads every recipe version reachable from `recipeGroupId` into `preloaded` — a plain
 * per-request local `Map`, never a persistent/shared cache, so there is no cross-tenant collision
 * surface: it is garbage collected the moment the calling request finishes. Named `preloaded`
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
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Unknown unit id '${row.unitId}' on a recipe component.`,
      });
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
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Unknown yield unit id '${version.yieldUnitId}' on a recipe.`,
    });
  }

  preloaded.set(recipeKey, {
    recipeGroupId: version.recipeGroupId,
    yieldQuantity: new Decimal(version.yieldQuantity),
    yieldUnit,
    components,
  });

  for (const row of componentRows) {
    if (row.componentType === 'RECIPE' && row.subRecipeGroupId) {
      await preloadRecipeTree(
        recipeRepository,
        unitCodeById,
        preloaded,
        row.subRecipeGroupId,
        asOf,
        depth + 1
      );
    }
  }
};

/**
 * Full cost breakdown for one recipe group, as of now. Throws `NOT_FOUND`-shaped errors for a
 * missing recipe so a router can surface them directly.
 */
export const resolveRecipeCostBreakdown = async (
  db: Db,
  organizationId: string,
  recipeGroupId: string,
  currency: CurrencyCode
) => {
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
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });
  }

  const resolver: RecipeResolver = (groupId, forAsOf) =>
    preloaded.get(`${groupId}::${forAsOf.toISOString()}`) ?? null;

  let exploded;
  try {
    exploded = explodeRecipe(
      rootRecipe,
      quantity(rootRecipe.yieldQuantity, rootRecipe.yieldUnit),
      asOf,
      resolver
    );
  } catch (err) {
    if (err instanceof RecipeDepthExceededError || err instanceof RecipeVersionNotFoundError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
    }
    throw err;
  }

  const lines: RecipeCostLine[] = [];
  for (const ingredient of exploded) {
    const confirmedMappings = await supplierProductRepository.findConfirmedForProduct(
      ingredient.productId
    );
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
      } =>
        entry.price !== null &&
        entry.price.currency === currency &&
        entry.mapping.conversionToBase !== null &&
        entry.mapping.packUnitId !== null
    );

    if (withCurrentPrice.length === 0) {
      lines.push({ productId: ingredient.productId, cost: 'unknown' });
      continue;
    }

    const cheapest = withCurrentPrice.reduce((min, entry) =>
      Number(entry.price.unitPrice) < Number(min.price.unitPrice) ? entry : min
    );

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
      const factorRow = await unitConversionRepository.findFactor(
        ingredientUnitId,
        product.baseUnitId,
        ingredient.productId
      );
      const conversionTable = factorRow
        ? [
            {
              fromUnitId: ingredientUnitId,
              toUnitId: product.baseUnitId,
              productId: factorRow.productId,
              factor: factorRow.factor,
            },
          ]
        : [];

      const qtyInBaseUnit = resolveQuantity(
        quantity(ingredient.quantity, ingredient.unit),
        baseUnitCode,
        ingredientUnitId,
        product.baseUnitId,
        conversionTable,
        ingredient.productId
      );

      // unitPrice is per PACK as purchased (e.g. $30 for a 25kg sack); conversionToBase says how
      // many base units one pack equals (25). Price per base unit = unitPrice / conversionToBase
      // ($1.20/kg); line cost = that rate * the quantity actually needed. The whole chain stays in
      // Decimal precision, never dropping into a plain JS number.
      const conversionToBase = cheapest.mapping.conversionToBase!;
      const lineCost = money(
        qtyInBaseUnit.amount.times(cheapest.price.unitPrice).dividedBy(conversionToBase),
        currency
      );
      lines.push({ productId: ingredient.productId, cost: lineCost });
    } catch {
      // Conversion failure of any kind resolves to unknown, never a guessed factor.
      lines.push({ productId: ingredient.productId, cost: 'unknown' });
    }
  }

  return computeRecipeCost(lines, currency);
};

/**
 * The cost of ONE unit of a recipe's output — what the dashboard needs per sold menu item.
 *
 * `resolveRecipeCostBreakdown` returns the cost of a whole BATCH: a croissant recipe that yields 12
 * reports the cost of making all 12. Multiplying that by units sold would overstate theoretical
 * COGS by the yield factor, so the batch cost is divided by `yieldQuantity` here. This division is
 * the difference between a plausible-looking number and a correct one, and it is exactly the kind
 * of error that is invisible on screen — the figure still looks like money.
 *
 * A recipe whose cost can't be fully resolved returns `'unknown'`, which propagates rather than
 * being silently dropped from the total.
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
    // A zero or negative yield is nonsensical rather than zero-cost — refuse to divide instead of
    // producing an infinity that would render as a real figure.
    if (yieldQuantity.lessThanOrEqualTo(0)) return 'unknown';

    return money(batch.total.amount.dividedBy(yieldQuantity), currency);
  } catch {
    // A missing or unresolvable recipe is an unknown cost for dashboard purposes, not a failed
    // request — one bad recipe must not blank the entire dashboard.
    return 'unknown';
  }
};
