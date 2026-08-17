import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { organizations, ProductRepository, RecipeRepository } from '@retailos/db';
import {
  generateId,
  RecipeDepthExceededError,
  RecipeVersionNotFoundError,
  type CurrencyCode,
} from '@retailos/domain';
import { protectedProcedure, router } from '../trpc';
import { RecipeNotFoundError, resolveRecipeCostBreakdown } from '@retailos/metrics';

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
    const [orgRow] = await ctx.db
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, ctx.session.organizationId));
    const currency = (orgRow?.baseCurrency ?? 'USD') as CurrencyCode;

    try {
      return await resolveRecipeCostBreakdown(ctx.db, ctx.session.organizationId, input.recipeGroupId, currency);
    } catch (err) {
      if (err instanceof RecipeNotFoundError) {
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
      }
      if (err instanceof RecipeDepthExceededError || err instanceof RecipeVersionNotFoundError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      throw err;
    }
  }),
});
