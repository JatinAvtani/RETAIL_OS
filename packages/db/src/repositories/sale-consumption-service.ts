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
  /** `'already_consumed'` (2026-09 addition): a retry found this ingredient already had a real `SALE_CONSUMPTION` movement posted for this exact `sourceId` — the retry-safety mechanism `checkRetry: true` callers rely on, distinguishing "consumed just now" from "consumed on a prior attempt, correctly not re-consumed" without ever double-drawing stock. */
  status: 'consumed' | 'already_consumed' | 'unit_conversion_unavailable' | 'insufficient_stock';
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
 * The CONSUMPTION side of "theoretical consumption from sales × recipe" —
 * deliberately sales-source-agnostic. `sales_transactions`/`pos_items` don't
 * exist anywhere in this codebase yet — they belong entirely to Sales Ingestion, which
 * is expected to call INTO this function once it exists, not the reverse.
 * This function is written to that boundary deliberately, rather than guessing at the
 * ingestion pipeline's eventual shape ahead of time.
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
 * Menu-item resolution failure (POSItem -> MenuItem missing) is explicitly the
 * unmapped-sales quarantine queue's job — this function starts one level in, already holding a real
 * `menuItemId`. A menu item that doesn't exist in THIS organization still returns a structured
 * `menu_item_not_found` result rather than throwing, so a caller processing many sale lines in a
 * batch can flag one bad line without the whole batch failing ("flag it, don't
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

  /**
   * Per-instance caches for data that is IMMUTABLE for the lifetime of one ingestion run.
   *
   * `recordSaleConsumption` re-read the menu item, every unit, and the entire recipe tree on every
   * call — once per sale line, ~98,000 times during a full seed, measured at 231 ms/sale. The
   * lookups are identical across lines; only the sale differs.
   *
   * **The recipe cache is keyed by `(recipeGroupId, asOf)`, never by group alone.** Recipes are
   * `validFrom`-dated, so the correct recipe genuinely differs by sale timestamp — caching per
   * group would resolve a later sale against an earlier sale's recipe version and silently produce
   * wrong costs, which is precisely the failure this cache must not introduce. That key is the same
   * one `preloadRecipeTree` already uses internally; this only widens its lifetime from one call to
   * one instance.
   *
   * Units and menu items are immutable master data within a run — a mid-run edit is not a case this
   * codebase's ingestion supports either way, since the pipeline already reads them once per line
   * without transactional isolation between lines.
   */
  private unitCodeById: Map<string, Unit> | null = null;
  private unitRowByCode: Map<string, { id: string; code: string }> | null = null;
  private readonly menuItemCache = new Map<string, Awaited<ReturnType<MenuItemRepository['findById']>>>();
  private readonly recipeCache = new Map<string, Recipe | null>();

  async recordSaleConsumption(input: {
    storeId: string;
    menuItemId: string;
    quantitySold: string;
    occurredAt: Date;
    currency: CurrencyCode;
    sourceType: string;
    sourceId?: string;
    actorUserId?: string;
    /** Retry-safety opt-in (2026-09 addition): when `true` (and `sourceId` is set), each ingredient's `consumeFefo` call checks for an already-posted movement before allocating, so a retried transaction never double-consumes stock it already consumed on a prior attempt. Off by default — the normal, never-retried sales-ingestion path has no reason to pay this extra read on every single sale. */
    checkRetry?: boolean;
  }): Promise<SaleConsumptionResult> {
    const menuItemRepository = new MenuItemRepository(this.db, this.organizationId);
    const recipeRepository = new RecipeRepository(this.db, this.organizationId);
    const productRepository = new ProductRepository(this.db, this.organizationId);
    const unitConversionRepository = new UnitConversionRepository(this.db, this.organizationId);
    const unitRepository = new UnitRepository(this.db);
    const movementService = new MovementService(this.db, this.organizationId);

    let menuItem = this.menuItemCache.get(input.menuItemId);
    if (menuItem === undefined) {
      menuItem = await menuItemRepository.findById(input.menuItemId);
      this.menuItemCache.set(input.menuItemId, menuItem);
    }
    if (!menuItem) {
      return { status: 'menu_item_not_found', menuItemId: input.menuItemId };
    }

    if (this.unitCodeById === null || this.unitRowByCode === null) {
      const allUnits = await unitRepository.findAll();
      this.unitCodeById = new Map(allUnits.map((u) => [u.id, u.code as Unit]));
      // Indexed by code rather than kept as an array: the ingredient lookup below ran a linear
      // `.find()` per ingredient per line, on top of re-reading the table itself.
      this.unitRowByCode = new Map(allUnits.map((u) => [u.code, u]));
    }
    const unitCodeById = this.unitCodeById;
    const unitRowByCode = this.unitRowByCode;

    // Shared across lines, but still keyed by (groupId, asOf) — `preloadRecipeTree` skips any key
    // already present, so a repeat sale of the same item at the same timestamp costs no queries
    // while a sale at a DIFFERENT timestamp still loads its own correct recipe version.
    const preloaded = this.recipeCache;
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

      const ingredientUnitRow = unitRowByCode.get(ingredient.unit);
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
          ...(input.checkRetry === true ? { checkIdempotent: true } : {}),
        });

        const status = result.alreadyConsumed ? 'already_consumed' : 'consumed';
        if (result.totalCost === null) {
          ingredients.push({ productId: ingredient.productId, status, actualCost: 'unknown' });
          anyUnknown = true;
        } else {
          ingredients.push({ productId: ingredient.productId, status, actualCost: result.totalCost });
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
