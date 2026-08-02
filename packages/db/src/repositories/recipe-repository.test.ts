import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { organizations, productVariants, products, recipeComponents, recipes } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { RecipeCycleError, RecipeRepository } from './recipe-repository';
import { ProductRepository } from './product-repository';
import { UnitRepository } from './unit-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('RecipeRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let kgId: string;
  let flourProductId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Recipe Test Org',
      slug: `recipe-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    const unitRepo = new UnitRepository(drizzle(client, { schema }));
    kgId = (await unitRepo.findByCode('kg'))!.id;

    const productRepo = new ProductRepository(createScopedDb(client), organizationId);
    const product = await productRepo.create({
      id: generateId(),
      sku: 'FLOUR-RECIPE',
      name: 'Flour',
      baseUnitId: kgId,
      type: 'INGREDIENT',
    });
    flourProductId = product.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    const orgRecipes = await adminDb.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, organizationId));
    for (const r of orgRecipes) {
      await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
    }
    await adminDb.delete(recipes).where(eq(recipes.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(productVariants).where(eq(productVariants.productId, flourProductId));
    await adminDb.delete(products).where(eq(products.id, flourProductId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('create writes a recipe and its components in one transaction', async () => {
    const repo = new RecipeRepository(createScopedDb(client), organizationId);
    const recipeGroupId = generateId();
    const recipe = await repo.create({
      id: generateId(),
      recipeGroupId,
      name: 'Tomato Sauce',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ componentType: 'PRODUCT', productId: flourProductId, quantity: '0.2', unitId: kgId }],
    });

    const components = await repo.findComponents(recipe.id);
    expect(components).toHaveLength(1);
    expect(components[0]?.productId).toBe(flourProductId);
  });

  it('findVersionAsOf returns null when no version is valid at that date', async () => {
    const repo = new RecipeRepository(createScopedDb(client), organizationId);
    const recipeGroupId = generateId();
    await repo.create({
      id: generateId(),
      recipeGroupId,
      name: 'Tomato Sauce',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-06-01T00:00:00Z'),
      components: [],
    });

    const result = await repo.findVersionAsOf(recipeGroupId, new Date('2026-01-01T00:00:00Z'));
    expect(result).toBeNull();
  });

  it('createNewVersion closes the previous open version and creates a new one', async () => {
    const repo = new RecipeRepository(createScopedDb(client), organizationId);
    const recipeGroupId = generateId();
    const v1 = await repo.create({
      id: generateId(),
      recipeGroupId,
      name: 'Tomato Sauce v1',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ componentType: 'PRODUCT', productId: flourProductId, quantity: '0.2', unitId: kgId }],
    });
    const v2 = await repo.createNewVersion({
      id: generateId(),
      recipeGroupId,
      name: 'Tomato Sauce v2',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-03-01T00:00:00Z'),
      components: [{ componentType: 'PRODUCT', productId: flourProductId, quantity: '0.5', unitId: kgId }],
    });

    const beforeChange = await repo.findVersionAsOf(recipeGroupId, new Date('2026-02-01T00:00:00Z'));
    const afterChange = await repo.findVersionAsOf(recipeGroupId, new Date('2026-04-01T00:00:00Z'));

    expect(beforeChange?.id).toBe(v1.id);
    expect(afterChange?.id).toBe(v2.id);
  });

  it('a direct self-reference is rejected as a cycle before any row is written', async () => {
    const repo = new RecipeRepository(createScopedDb(client), organizationId);
    const recipeGroupId = generateId();

    await expect(
      repo.create({
        id: generateId(),
        recipeGroupId,
        name: 'Self-referencing',
        yieldQuantity: '1',
        yieldUnitId: kgId,
        validFrom: new Date('2026-01-01T00:00:00Z'),
        components: [{ componentType: 'RECIPE', subRecipeGroupId: recipeGroupId, quantity: '1', unitId: kgId }],
      })
    ).rejects.toThrow(RecipeCycleError);

    const found = await repo.findVersionAsOf(recipeGroupId, new Date('2026-01-01T00:00:00Z'));
    expect(found).toBeNull();
  });

  it('an indirect cycle (A -> B -> A) is rejected', async () => {
    const repo = new RecipeRepository(createScopedDb(client), organizationId);
    const groupA = generateId();
    const groupB = generateId();

    await repo.create({
      id: generateId(),
      recipeGroupId: groupA,
      name: 'Recipe A',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ componentType: 'PRODUCT', productId: flourProductId, quantity: '0.1', unitId: kgId }],
    });

    await expect(
      repo.create({
        id: generateId(),
        recipeGroupId: groupB,
        name: 'Recipe B',
        yieldQuantity: '1',
        yieldUnitId: kgId,
        validFrom: new Date('2026-01-01T00:00:00Z'),
        components: [{ componentType: 'RECIPE', subRecipeGroupId: groupA, quantity: '1', unitId: kgId }],
      })
    ).resolves.toBeDefined();

    // Now try to make A depend on B, closing the cycle A -> B -> A. Since A already has a
    // component (flour), we version it instead of creating fresh.
    await expect(
      repo.createNewVersion({
        id: generateId(),
        recipeGroupId: groupA,
        name: 'Recipe A v2',
        yieldQuantity: '1',
        yieldUnitId: kgId,
        validFrom: new Date('2026-02-01T00:00:00Z'),
        components: [{ componentType: 'RECIPE', subRecipeGroupId: groupB, quantity: '1', unitId: kgId }],
      })
    ).rejects.toThrow(RecipeCycleError);
  });

  it('a non-cyclic diamond (A -> B, A -> C, B -> D, C -> D) is accepted', async () => {
    const repo = new RecipeRepository(createScopedDb(client), organizationId);
    const groupD = generateId();
    const groupB = generateId();
    const groupC = generateId();
    const groupA = generateId();

    await repo.create({
      id: generateId(),
      recipeGroupId: groupD,
      name: 'D',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ componentType: 'PRODUCT', productId: flourProductId, quantity: '0.1', unitId: kgId }],
    });
    await repo.create({
      id: generateId(),
      recipeGroupId: groupB,
      name: 'B',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ componentType: 'RECIPE', subRecipeGroupId: groupD, quantity: '1', unitId: kgId }],
    });
    await repo.create({
      id: generateId(),
      recipeGroupId: groupC,
      name: 'C',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ componentType: 'RECIPE', subRecipeGroupId: groupD, quantity: '1', unitId: kgId }],
    });

    await expect(
      repo.create({
        id: generateId(),
        recipeGroupId: groupA,
        name: 'A',
        yieldQuantity: '1',
        yieldUnitId: kgId,
        validFrom: new Date('2026-01-01T00:00:00Z'),
        components: [
          { componentType: 'RECIPE', subRecipeGroupId: groupB, quantity: '1', unitId: kgId },
          { componentType: 'RECIPE', subRecipeGroupId: groupC, quantity: '1', unitId: kgId },
        ],
      })
    ).resolves.toBeDefined();
  });
});
