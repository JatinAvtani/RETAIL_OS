import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import {
  organizations,
  ProductRepository,
  RecipeRepository,
  SupplierPriceRepository,
  SupplierProductRepository,
  UnitConversionRepository,
  UnitRepository,
} from '@retailos/db';
import {
  explodeRecipe,
  generateId,
  money,
  quantity,
  resolveQuantity,
  RecipeDepthExceededError,
  RecipeVersionNotFoundError,
  type CurrencyCode,
  type Recipe,
  type RecipeComponent,
  type RecipeResolver,
  type Unit,
} from '@retailos/domain';
import { computeRecipeCost, type RecipeCostLine } from '@retailos/metrics';
import { protectedProcedure, router } from '../trpc';

const componentInput = z.object({
  componentType: z.enum(['PRODUCT', 'RECIPE']),
  productId: z.string().uuid().optional(),
  subRecipeGroupId: z.string().uuid().optional(),
  quantity: z.string(),
  unitId: z.string().uuid(),
  wasteFactor: z.string().optional(),
});

const createInput = z.object({
  name: z.string().min(1),
  yieldQuantity: z.string(),
  yieldUnitId: z.string().uuid(),
  components: z.array(componentInput).min(1),
});

const getInput = z.object({ recipeGroupId: z.string().uuid() });
const costInput = z.object({ recipeGroupId: z.string().uuid() });

/**
 * Recursively loads every recipe version reachable from `recipeGroupId` into `preloaded` — a
 * plain per-request local `Map`, freshly constructed inside `cost`'s own request handler below,
 * never a persistent/shared cache (no Redis, no module-level state) — so there is no cross-tenant
 * collision surface for I4's "cache key must include organization_id" rule to catch: it's garbage
 * collected the moment this one request finishes, the same as any other local variable. Named
 * `preloaded`/`recipeKey`, not `cache`/`cacheKey`, specifically to keep this legible as what it
 * is (a preload buffer for one request) rather than something that reads like a real cache.
 *
 * Keyed the same way the synchronous `RecipeResolver` (packages/domain) looks things up —
 * `explodeRecipe` is pure/no-I/O by design, so every DB row it might need has to be fetched
 * BEFORE calling it, not lazily during recursion. Depth-bounded the same way `explodeRecipe`
 * itself is (defense in depth; `RecipeRepository`'s save-time DFS is the primary cycle guard).
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
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Unknown unit id '${row.unitId}' on a recipe component.` });
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
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Unknown yield unit id '${version.yieldUnitId}' on a recipe.` });
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

export const recipesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const recipeRepository = new RecipeRepository(ctx.db, ctx.session.organizationId);
    return recipeRepository.findAllCurrent();
  }),

  get: protectedProcedure.input(getInput).query(async ({ ctx, input }) => {
    const recipeRepository = new RecipeRepository(ctx.db, ctx.session.organizationId);
    const version = await recipeRepository.findVersionAsOf(input.recipeGroupId, new Date());
    if (!version) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });
    }
    const components = await recipeRepository.findComponents(version.id);
    return { ...version, components };
  }),

  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const recipeRepository = new RecipeRepository(ctx.db, ctx.session.organizationId);
    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);

    // recipe_components.productId/subRecipeGroupId are real FKs but NOT org-scoped at the
    // database level (recipe_components has no organization_id of its own — RLS on it is
    // subquery-based through recipes). Without this check, a caller could reference ANY
    // product/recipe id that exists anywhere, including another tenant's — verified up front,
    // the same shape as products.create/categories.create's categoryId check.
    for (const component of input.components) {
      if (component.componentType === 'PRODUCT') {
        const product = component.productId ? await productRepository.findById(component.productId) : null;
        if (!product) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `productId '${component.productId}' does not refer to a product in this organization.` });
        }
      } else {
        const subRecipe = component.subRecipeGroupId
          ? await recipeRepository.findVersionAsOf(component.subRecipeGroupId, new Date())
          : null;
        if (!subRecipe) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `subRecipeGroupId '${component.subRecipeGroupId}' does not refer to a recipe in this organization.` });
        }
      }
    }

    const recipeGroupId = generateId();
    try {
      return await recipeRepository.create({
        id: generateId(),
        recipeGroupId,
        name: input.name,
        yieldQuantity: input.yieldQuantity,
        yieldUnitId: input.yieldUnitId,
        validFrom: new Date(),
        components: input.components.map((component) => ({
          componentType: component.componentType,
          quantity: component.quantity,
          unitId: component.unitId,
          ...(component.productId !== undefined && { productId: component.productId }),
          ...(component.subRecipeGroupId !== undefined && { subRecipeGroupId: component.subRecipeGroupId }),
          ...(component.wasteFactor !== undefined && { wasteFactor: component.wasteFactor }),
        })),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'RecipeCycleError') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      throw err;
    }
  }),

  /**
   * The live-cost computation the recipe builder UI calls as components are edited. Per exploded
   * ingredient line: find confirmed supplier mappings for that product, pick the LOWEST current
   * price among them (asked the user — matches how a kitchen actually sources, and is the more
   * conservative estimate), convert the ingredient's exploded quantity into the product's own
   * base unit via `resolveQuantity` (I6 — one explicit boundary conversion, using a real
   * `unit_conversions` factor, never an inline guess), then divide the pack price by
   * `conversionToBase` (confirmed with the user: `unitPrice` is per PACK as purchased, e.g.
   * $30/25kg-sack, so cost-per-base-unit = unitPrice / conversionToBase) to get a real
   * cost-per-base-unit, and multiply. Every line's resolved cost (or 'unknown') goes to
   * `computeRecipeCost` (packages/metrics, I2) — the only function allowed to sum them.
   */
  cost: protectedProcedure.input(costInput).query(async ({ ctx, input }) => {
    const recipeRepository = new RecipeRepository(ctx.db, ctx.session.organizationId);
    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const supplierProductRepository = new SupplierProductRepository(ctx.db, ctx.session.organizationId);
    const supplierPriceRepository = new SupplierPriceRepository(ctx.db, ctx.session.organizationId);
    const unitConversionRepository = new UnitConversionRepository(ctx.db, ctx.session.organizationId);
    const unitRepository = new UnitRepository(ctx.db);

    const allUnits = await unitRepository.findAll();
    const unitCodeById = new Map(allUnits.map((u) => [u.id, u.code as Unit]));
    const unitIdByCode = new Map(allUnits.map((u) => [u.code, u.id]));

    const asOf = new Date();
    // Freshly constructed for this one request — never a persistent/shared cache. See
    // preloadRecipeTree's doc comment for why this doesn't need a tenant-scoped key.
    const preloaded = new Map<string, Recipe | null>();
    await preloadRecipeTree(recipeRepository, unitCodeById, preloaded, input.recipeGroupId, asOf);

    const rootRecipe = preloaded.get(`${input.recipeGroupId}::${asOf.toISOString()}`);
    if (!rootRecipe) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found.' });
    }

    const resolver: RecipeResolver = (groupId, forAsOf) => preloaded.get(`${groupId}::${forAsOf.toISOString()}`) ?? null;

    let exploded;
    try {
      exploded = explodeRecipe(rootRecipe, quantity(rootRecipe.yieldQuantity, rootRecipe.yieldUnit), asOf, resolver);
    } catch (err) {
      if (err instanceof RecipeDepthExceededError || err instanceof RecipeVersionNotFoundError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      throw err;
    }

    const [orgRow] = await ctx.db
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, ctx.session.organizationId));
    const currency = (orgRow?.baseCurrency ?? 'USD') as CurrencyCode;

    const lines: RecipeCostLine[] = [];
    for (const ingredient of exploded) {
      const confirmedMappings = await supplierProductRepository.findConfirmedForProduct(ingredient.productId);
      const withCurrentPrice = (
        await Promise.all(
          confirmedMappings.map(async (mapping) => ({ mapping, price: await supplierPriceRepository.findCurrent(mapping.id) }))
        )
      ).filter((entry): entry is { mapping: (typeof confirmedMappings)[number]; price: NonNullable<Awaited<ReturnType<typeof supplierPriceRepository.findCurrent>>> } =>
        entry.price !== null && entry.price.currency === currency && entry.mapping.conversionToBase !== null && entry.mapping.packUnitId !== null
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

        // unitPrice is per PACK as purchased (e.g. $30 for a 25kg sack); conversionToBase says
        // how many base units one pack equals (25). Price per base unit = unitPrice /
        // conversionToBase ($1.20/kg); line cost = that rate * the quantity actually needed.
        // qtyInBaseUnit.amount is already a real Decimal (packages/domain's Quantity wraps one),
        // so the division/multiplication chain stays in Decimal precision throughout, never
        // dropping into a plain JS number (I5).
        const conversionToBase = cheapest.mapping.conversionToBase!;
        const lineCost = money(
          qtyInBaseUnit.amount.times(cheapest.price.unitPrice).dividedBy(conversionToBase),
          currency
        );
        lines.push({ productId: ingredient.productId, cost: lineCost });
      } catch {
        // ConversionNotFoundError or any other resolution failure — I7: unknown, never a guess.
        lines.push({ productId: ingredient.productId, cost: 'unknown' });
      }
    }

    return computeRecipeCost(lines, currency);
  }),
});
