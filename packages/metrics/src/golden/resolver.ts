import { Decimal } from 'decimal.js';
import type { createDb } from '@retailos/db';
import { RecipeRepository, SupplierPriceRepository, SupplierProductRepository, UnitRepository } from '@retailos/db';
import { explodeRecipe, money, quantity, type CurrencyCode, type Money, type Recipe, type RecipeComponent, type RecipeResolver, type Unit } from '@retailos/domain';

type Db = ReturnType<typeof createDb>['db'];

/**
 * A REAL (not stubbed) recipe-unit-cost resolver for the golden regression fixture.
 * Confirmed with the user over a stub: `packages/metrics`' own test convention always injects a
 * stub `resolveRecipeUnitCost` (returns 'unknown' or a hardcoded value) — a stub can never catch a
 * real recipe-explosion/cost-resolution bug, the same reasoning behind the standing
 * `retailos-verify-spec-formulas-and-test-doubles` lesson. This is genuinely smaller than
 * `apps/api/src/metrics/recipe-cost-resolver.ts` (no sub-recipes, no unit-conversion-table lookup,
 * no `TRPCError` — `apps/api`-only, `packages/metrics` cannot depend on it, a real module-boundary
 * constraint), but every step it DOES perform is real: real recipe explosion via
 * `@retailos/domain`'s `explodeRecipe`, real confirmed supplier-price lookup, real batch-to-per-unit
 * division. The golden fixture is deliberately built so this scope is sufficient (a direct
 * `PRODUCT` component, no sub-recipes, recipe component unit matching the product's base unit) —
 * this resolver is not meant to be general-purpose, only real.
 */
export const resolveGoldenRecipeUnitCost = async (
  db: Db,
  organizationId: string,
  recipeGroupId: string,
  currency: CurrencyCode
): Promise<Money | 'unknown'> => {
  const recipeRepository = new RecipeRepository(db, organizationId);
  const supplierProductRepository = new SupplierProductRepository(db, organizationId);
  const supplierPriceRepository = new SupplierPriceRepository(db, organizationId);
  const unitRepository = new UnitRepository(db);

  const allUnits = await unitRepository.findAll();
  const unitCodeById = new Map(allUnits.map((u) => [u.id, u.code as Unit]));

  const asOf = new Date();
  const version = await recipeRepository.findVersionAsOf(recipeGroupId, asOf);
  if (!version) return 'unknown';

  const componentRows = await recipeRepository.findComponents(version.id);
  if (componentRows.some((row) => row.componentType !== 'PRODUCT')) {
    // This resolver is deliberately scoped to direct-product-only recipes — the golden fixture
    // never builds a sub-recipe, so this branch is unreachable in practice, not silently wrong.
    return 'unknown';
  }

  const componentUnit = unitCodeById.get(componentRows[0]!.unitId);
  const yieldUnit = unitCodeById.get(version.yieldUnitId);
  if (!componentUnit || !yieldUnit) return 'unknown';

  const components: RecipeComponent[] = componentRows.map((row) => ({
    componentType: 'PRODUCT',
    productId: row.productId!,
    quantity: new Decimal(row.quantity),
    unit: unitCodeById.get(row.unitId)!,
    wasteFactor: new Decimal(row.wasteFactor),
  }));

  const recipe: Recipe = {
    recipeGroupId: version.recipeGroupId,
    yieldQuantity: new Decimal(version.yieldQuantity),
    yieldUnit,
    components,
  };

  const resolver: RecipeResolver = () => null; // no sub-recipes in the golden fixture

  const exploded = explodeRecipe(recipe, quantity(recipe.yieldQuantity, recipe.yieldUnit), asOf, resolver);

  let batchTotal = new Decimal(0);
  for (const ingredient of exploded) {
    const confirmedMappings = await supplierProductRepository.findConfirmedForProduct(ingredient.productId);
    const withCurrentPrice = (
      await Promise.all(confirmedMappings.map(async (mapping) => ({ mapping, price: await supplierPriceRepository.findCurrent(mapping.id) })))
    ).filter(
      (entry): entry is { mapping: (typeof confirmedMappings)[number]; price: NonNullable<typeof entry.price> } =>
        entry.price !== null && entry.price.currency === currency && entry.mapping.conversionToBase !== null
    );

    if (withCurrentPrice.length === 0) return 'unknown';
    const cheapest = withCurrentPrice.reduce((min, entry) => (Number(entry.price.unitPrice) < Number(min.price.unitPrice) ? entry : min));

    // `unitPrice` is per PACK as purchased; `conversionToBase` says how many base units one pack
    // equals — the same real per-base-unit rate math `apps/api`'s production resolver uses. The
    // golden fixture keeps the recipe component's unit equal to the product's base unit (no
    // conversion-table lookup needed for THAT step), but pack-to-base-unit division is real and
    // load-bearing regardless — skipping it would silently overstate cost by the pack size.
    const ratePerBaseUnit = new Decimal(cheapest.price.unitPrice).dividedBy(cheapest.mapping.conversionToBase!);
    batchTotal = batchTotal.plus(ingredient.quantity.times(ratePerBaseUnit));
  }

  const yieldQuantity = new Decimal(version.yieldQuantity);
  if (yieldQuantity.lessThanOrEqualTo(0)) return 'unknown';
  return money(batchTotal.dividedBy(yieldQuantity), currency);
};
