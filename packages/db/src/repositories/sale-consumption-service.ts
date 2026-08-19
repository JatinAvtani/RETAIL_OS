import { drizzle } from 'drizzle-orm/postgres-js';
import { Decimal } from 'decimal.js';
import * as schema from '../schema/index';
import { MenuItemRepository } from './menu-item-repository';
import { RecipeRepository } from './recipe-repository';
import { ProductRepository } from './product-repository';
import { UnitConversionRepository } from './unit-conversion-repository';
import { UnitRepository } from './unit-repository';
import { MovementService, InsufficientStockError } from './movement-service';
import {
  explodeRecipe,
  resolveQuantity,
  quantity,
  addMoney,
  zeroMoney,
  RecipeDepthExceededError,
  RecipeVersionNotFoundError,
  type CurrencyCode,
  type Money,
  type Recipe,
  type RecipeComponent,
  type RecipeResolver,
  type Unit,
} from '@retailos/domain';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * One exploded ingredient's consumption outcome. `'unknown'` (never a guessed number) covers every
 * way this can fail to produce a real cost: no unit conversion exists to the product's base unit,
 * or the lots FEFO drew from didn't all have a known cost — matching `computeRecipeCost`'s
 * (`packages/metrics`) existing "any unknown line makes the whole result unknown" convention,
 * applied here to the ACTUAL cost of what was consumed rather than the planned/theoretical cost.
 */
export type IngredientConsumptionResult = {
  productId: string;
  status: 'consumed' | 'unit_conversion_unavailable' | 'insufficient_stock';
  actualCost: Money | 'unknown';
};

export type SaleConsumptionResult =
  | { status: 'menu_item_not_found'; menuItemId: string }
  | { status: 'recipe_not_found'; menuItemId: string; recipeGroupId: string; asOf: Date }
  | {
      status: 'consumed';
      menuItemId: string;
      ingredients: IngredientConsumptionResult[];
      /** `'unknown'` if ANY ingredient's actualCost is unknown — never a partial sum (I7), same rule `computeRecipeCost` already enforces for theoretical cost. */
      actualCogs: Money | 'unknown';
    };

/**
 * earlier work's actual scope: the CONSUMPTION side of "theoretical consumption from sales × recipe"
 * deliberately sales-source-agnostic. `sales_transactions`/`pos_items` don't
 * exist anywhere in this codebase yet — they belong entirely to a later milestone (Sales Ingestion), whose
 * own task list names `earlier work` "Trigger consumption on ingest (wires to a later milestone)" — meaning
 * a later milestone is the one expected to call INTO this function once it exists, not the reverse.
 * Confirmed with the user rather than assumed, since guessing at the later milestone's shape now would be
 * exactly the kind of speculative building CLAUDE.md warns against.
 *
 * Given an already-resolved `menuItemId` + `quantitySold` + `occurredAt` (whatever calls this
 * — eventually a POS sale line, but this function has no opinion on where they came from), does the
 * real work a later milestone owns:
 *   MenuItem -> Recipe (version valid at occurredAt)?
 *     NOT FOUND -> return `recipe_not_found`, never silently skip
 *   -> explodeRecipe
 *   -> for each ingredient: resolve its default variant + base unit, convert the exploded quantity,
 *      FEFO-allocate via `MovementService.consumeFefo`
 *   -> record actual COGS from the REAL allocated lot costs (never the theoretical/planned recipe
 *      cost `recipes.cost`/`computeRecipeCost` compute — those are a different number entirely)
 *
 * Menu-item resolution failure (POSItem -> MenuItem missing) is explicitly earlier work's job (the
 * unmapped-sales quarantine queue) — this function starts one level in, already holding a real
 * `menuItemId`. A menu item that doesn't exist in THIS organization still returns a structured
 * `menu_item_not_found` result rather than throwing, so a caller processing many sale lines in a
 * batch can flag one bad line without the whole batch failing (the design: "flag it, don't
 * silently drop it, and don't guess" — the same principle applies whether the flag is presented to
 * a human or returned to a batch-processing caller).
 *
 * Insufficient stock is NOT a failure of this function — `MovementService.consumeFefo` throwing
 * `InsufficientStockError` is caught per-ingredient and recorded as `insufficient_stock` with
 * `actualCost: 'unknown'`, letting every OTHER ingredient in the same sale still post normally
 * (negative stock is a signal per the plan, but a shortfall on flour shouldn't block posting the
 * cheese and lettuce that DID have stock).
 */
export class SaleConsumptionService {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('SaleConsumptionService constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  async recordSaleConsumption(input: {
    storeId: string;
    menuItemId: string;
    quantitySold: string;
    occurredAt: Date;
    currency: CurrencyCode;
    sourceType: string;
    sourceId?: string;
    actorUserId?: string;
  }): Promise<SaleConsumptionResult> {
    const menuItemRepository = new MenuItemRepository(this.db, this.organizationId);
    const recipeRepository = new RecipeRepository(this.db, this.organizationId);
    const productRepository = new ProductRepository(this.db, this.organizationId);
    const unitConversionRepository = new UnitConversionRepository(this.db, this.organizationId);
    const unitRepository = new UnitRepository(this.db);
    const movementService = new MovementService(this.db, this.organizationId);

    const menuItem = await menuItemRepository.findById(input.menuItemId);
    if (!menuItem) {
      return { status: 'menu_item_not_found', menuItemId: input.menuItemId };
    }

    const allUnits = await unitRepository.findAll();
    const unitCodeById = new Map(allUnits.map((u) => [u.id, u.code as Unit]));

    const preloaded = new Map<string, Recipe | null>();
    await preloadRecipeTree(recipeRepository, unitCodeById, preloaded, menuItem.recipeGroupId, input.occurredAt);

    const rootKey = `${menuItem.recipeGroupId}::${input.occurredAt.toISOString()}`;
    const rootRecipe = preloaded.get(rootKey);
    if (!rootRecipe) {
      return {
        status: 'recipe_not_found',
        menuItemId: input.menuItemId,
        recipeGroupId: menuItem.recipeGroupId,
        asOf: input.occurredAt,
      };
    }

    const resolver: RecipeResolver = (groupId, asOf) => preloaded.get(`${groupId}::${asOf.toISOString()}`) ?? null;

    let exploded;
    try {
      exploded = explodeRecipe(
        rootRecipe,
        quantity(input.quantitySold, rootRecipe.yieldUnit),
        input.occurredAt,
        resolver
      );
    } catch (err) {
      if (err instanceof RecipeDepthExceededError || err instanceof RecipeVersionNotFoundError) {
        return {
          status: 'recipe_not_found',
          menuItemId: input.menuItemId,
          recipeGroupId: menuItem.recipeGroupId,
          asOf: input.occurredAt,
        };
      }
      throw err;
    }

    const ingredients: IngredientConsumptionResult[] = [];
    let anyUnknown = false;
    let cogs = zeroMoney(input.currency);

    for (const ingredient of exploded) {
      const product = await productRepository.findById(ingredient.productId);
      if (!product) {
        ingredients.push({ productId: ingredient.productId, status: 'unit_conversion_unavailable', actualCost: 'unknown' });
        anyUnknown = true;
        continue;
      }

      const baseUnitCode = unitCodeById.get(product.baseUnitId);
      const variants = await productRepository.findVariants(product.id);
      const defaultVariant = variants[0];
      if (!baseUnitCode || !defaultVariant) {
        ingredients.push({ productId: ingredient.productId, status: 'unit_conversion_unavailable', actualCost: 'unknown' });
        anyUnknown = true;
        continue;
      }

      const ingredientUnitRow = allUnits.find((u) => u.code === ingredient.unit);
      if (!ingredientUnitRow) {
        ingredients.push({ productId: ingredient.productId, status: 'unit_conversion_unavailable', actualCost: 'unknown' });
        anyUnknown = true;
        continue;
      }

      let qtyInBaseUnit;
      try {
        const factorRow = await unitConversionRepository.findFactor(ingredientUnitRow.id, product.baseUnitId, ingredient.productId);
        const conversionTable = factorRow
          ? [{ fromUnitId: ingredientUnitRow.id, toUnitId: product.baseUnitId, productId: factorRow.productId, factor: factorRow.factor }]
          : [];
        qtyInBaseUnit = resolveQuantity(
          quantity(ingredient.quantity, ingredient.unit),
          baseUnitCode,
          ingredientUnitRow.id,
          product.baseUnitId,
          conversionTable,
          ingredient.productId
        );
      } catch {
        // No conversion exists (I6/I7): this ingredient's true consumption cannot be stated —
        // degrade to unknown, never guess a 1:1 factor.
        ingredients.push({ productId: ingredient.productId, status: 'unit_conversion_unavailable', actualCost: 'unknown' });
        anyUnknown = true;
        continue;
      }

      try {
        const result = await movementService.consumeFefo({
          storeId: input.storeId,
          productId: ingredient.productId,
          variantId: defaultVariant.id,
          requiredQuantity: qtyInBaseUnit.amount.toString(),
          unit: baseUnitCode,
          occurredAt: input.occurredAt,
          sourceType: input.sourceType,
          ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
          ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
        });

        if (result.totalCost === null) {
          ingredients.push({ productId: ingredient.productId, status: 'consumed', actualCost: 'unknown' });
          anyUnknown = true;
        } else {
          ingredients.push({ productId: ingredient.productId, status: 'consumed', actualCost: result.totalCost });
          if (!anyUnknown) {
            cogs = addMoney(cogs, result.totalCost);
          }
        }
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          ingredients.push({ productId: ingredient.productId, status: 'insufficient_stock', actualCost: 'unknown' });
          anyUnknown = true;
          continue;
        }
        throw err;
      }
    }

    return {
      status: 'consumed',
      menuItemId: input.menuItemId,
      ingredients,
      actualCogs: anyUnknown ? 'unknown' : cogs,
    };
  }
}

/**
 * Identical shape/reasoning to `apps/api/src/trpc/routers/recipes.ts`'s own `preloadRecipeTree` —
 * `explodeRecipe` is pure/no-I/O, so every recipe version it might recurse into has to be fetched
 * BEFORE calling it, not lazily during recursion. Not shared code with that router (different
 * package, `packages/db` vs `apps/api`) — duplicated deliberately rather than introducing a
 * cross-package dependency for one small helper; if a third caller needs it, that's the signal to
 * extract it into `packages/domain` or a shared `packages/db` module.
 */
const preloadRecipeTree = async (
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
