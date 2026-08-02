import { createDb, categories, products, recipeComponents, recipes, stores, units } from '@retailos/db';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import { buildProductImageKey, createPresignedUploadUrl, ensureBucketExists } from '@retailos/storage';
import { PRODUCT_IMAGES_BUCKET, storageClient } from './context';

type Db = ReturnType<typeof createDb>['db'];

/**
 * Task 003-13, spec 14 §14.3: "enumerate every registered route; for each, call with tenant B's
 * session against a tenant A resource id. Expect 403/404, never 200." This is the registry half of
 * that suite (see `cross-tenant.test.ts` for the runner) — a real, generic auto-attacker can't be
 * built without SOME per-endpoint knowledge, because there is no mechanical way to derive "what a
 * resource id looks like for this procedure" from a tRPC router alone (`stores.get` needs
 * `{ id: storeId }`; a hypothetical future `purchasing.get` might need `{ id: poId }`; an endpoint
 * with no resource id at all, like `invitations.create`, isn't in scope for THIS check — it has
 * nothing to attack by id).
 *
 * The reusable part — and what makes this "every future endpoint inherits it automatically" true
 * in practice — is the RUNNER, not this file. Adding cross-tenant coverage for a new endpoint is
 * one entry here (seed a resource, describe its shape), not a new hand-written test file.
 */
export type ResourceScopedProcedure = {
  /** Dotted tRPC path, e.g. 'stores.get'. */
  path: string;
  /** 'query' procedures are called via GET + ?input=; 'mutation' via POST + JSON body. */
  type: 'query' | 'mutation';
  /** Seeds a real resource belonging to `organizationId` and returns its id. */
  seedResource: (db: Db, organizationId: string) => Promise<string>;
  /**
   * Builds the procedure's input given the (attacker-supplied) resource id, its owning org, and
   * a real db handle — most entries don't need `db` (their id alone is the whole payload), but a
   * `create`-shaped attack (e.g. products.create referencing another tenant's categoryId) needs
   * one real value looked up fresh (a global unit id) so the "own resource" positive case gets a
   * genuine 200, not an incidental failure unrelated to what the entry is actually testing.
   */
  buildInput: (
    resourceId: string,
    organizationId: string,
    db: Db
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
};

/** Seeds a real product (needs a real baseUnitId FK — 'each' is part of the seeded global vocabulary). */
const seedProduct = async (db: Db, organizationId: string): Promise<string> => {
  const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
  if (!eachUnit) {
    throw new Error("Cross-tenant registry: seeded unit 'each' not found — migrations not applied?");
  }
  const productId = generateId();
  await db.insert(products).values({
    id: productId,
    organizationId,
    sku: `cross-tenant-probe-${productId}`,
    name: `Cross-tenant probe product ${productId}`,
    baseUnitId: eachUnit.id,
    type: 'INGREDIENT',
  });
  return productId;
};

/** Seeds a real root category. */
const seedCategory = async (db: Db, organizationId: string): Promise<string> => {
  const categoryId = generateId();
  await db.insert(categories).values({
    id: categoryId,
    organizationId,
    name: `Cross-tenant probe category ${categoryId}`,
    path: `/${categoryId}`,
  });
  return categoryId;
};

/** Seeds a real, one-component recipe (a real product component, needs a real baseUnitId/unitId). */
const seedRecipe = async (db: Db, organizationId: string): Promise<string> => {
  const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
  if (!eachUnit) {
    throw new Error("Cross-tenant registry: seeded unit 'each' not found — migrations not applied?");
  }
  const productId = await seedProduct(db, organizationId);
  const recipeGroupId = generateId();
  const recipeId = generateId();
  await db.insert(recipes).values({
    id: recipeId,
    recipeGroupId,
    organizationId,
    name: `Cross-tenant probe recipe ${recipeGroupId}`,
    yieldQuantity: '1',
    yieldUnitId: eachUnit.id,
    validFrom: new Date(),
  });
  await db.insert(recipeComponents).values({
    id: generateId(),
    recipeId,
    componentType: 'PRODUCT',
    productId,
    quantity: '1',
    unitId: eachUnit.id,
  });
  return recipeGroupId;
};

export const resourceScopedProcedures: ResourceScopedProcedure[] = [
  {
    path: 'stores.get',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const storeId = generateId();
      await db.insert(stores).values({
        id: storeId,
        organizationId,
        name: `Cross-tenant probe store ${storeId}`,
        timezone: 'America/New_York',
      });
      return storeId;
    },
    buildInput: (resourceId) => ({ id: resourceId }),
  },
  {
    path: 'products.get',
    type: 'query',
    seedResource: seedProduct,
    buildInput: (resourceId) => ({ id: resourceId }),
  },
  {
    // Not a "fetch by id" attack — the risk here is creating a NEW product that REFERENCES
    // another tenant's categoryId. seedResource seeds the referenced category (in tenant A);
    // buildInput builds a real create payload pointing at it. `units` is a global, non-tenant
    // lookup table (see schema comments), so its own connection here is fine — a fixed, stable
    // seeded value ('each'), not per-test-run generated data.
    path: 'products.create',
    type: 'mutation',
    seedResource: seedCategory,
    buildInput: async (resourceId, _organizationId, db) => {
      const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
      if (!eachUnit) {
        throw new Error("Cross-tenant registry: seeded unit 'each' not found — migrations not applied?");
      }
      return {
        sku: `cross-tenant-create-probe-${resourceId}`,
        name: 'Cross-tenant create attempt',
        baseUnitId: eachUnit.id,
        type: 'INGREDIENT',
        categoryId: resourceId,
      };
    },
  },
  {
    path: 'products.update',
    type: 'mutation',
    seedResource: seedProduct,
    buildInput: (resourceId) => ({ id: resourceId, name: 'Cross-tenant update attempt' }),
  },
  {
    // Same shape as products.create's entry: not a fetch-by-id, but a create REFERENCING another
    // tenant's category as its parent.
    path: 'categories.create',
    type: 'mutation',
    seedResource: seedCategory,
    buildInput: (resourceId) => ({ name: 'Cross-tenant create attempt', parentId: resourceId }),
  },
  {
    path: 'recipes.get',
    type: 'query',
    seedResource: seedRecipe,
    buildInput: (resourceId) => ({ recipeGroupId: resourceId }),
  },
  {
    path: 'recipes.cost',
    type: 'query',
    seedResource: seedRecipe,
    buildInput: (resourceId) => ({ recipeGroupId: resourceId }),
  },
  {
    // Same "seed the REFERENCED resource" shape as products.create/categories.create: the risk
    // is a new recipe's PRODUCT component referencing another tenant's productId, not fetching a
    // recipe by id. seedResource seeds a real product in tenant A; buildInput builds a real
    // one-component recipe.create payload pointing at it.
    path: 'recipes.create',
    type: 'mutation',
    seedResource: seedProduct,
    buildInput: async (resourceId, _organizationId, db) => {
      const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
      if (!eachUnit) {
        throw new Error("Cross-tenant registry: seeded unit 'each' not found — migrations not applied?");
      }
      return {
        name: 'Cross-tenant create attempt',
        yieldQuantity: '1',
        yieldUnitId: eachUnit.id,
        components: [
          {
            componentType: 'PRODUCT',
            productId: resourceId,
            quantity: '1',
            unitId: eachUnit.id,
          },
        ],
      };
    },
  },
  {
    path: 'products.requestImageUpload',
    type: 'mutation',
    seedResource: seedProduct,
    buildInput: (resourceId) => ({ productId: resourceId, contentType: 'image/jpeg' }),
  },
  {
    path: 'products.confirmImageUpload',
    type: 'mutation',
    // Uploads a REAL, valid JPEG at the exact key `confirmImageUpload` would look for
    // (buildProductImageKey's format is a pure function of org+product+extension), so the "tenant
    // A can fetch their own resource" positive-path test gets a genuine 200, not an incidental
    // error from a nonexistent object. The primary check the attacker actually hits first is
    // still ProductRepository.findById returning null cross-org, exactly like every other
    // endpoint here — this upload only exists to make the OWN-resource case work end to end.
    seedResource: async (db, organizationId) => {
      const productId = await seedProduct(db, organizationId);
      await ensureBucketExists(storageClient, PRODUCT_IMAGES_BUCKET);
      const key = buildProductImageKey(organizationId, productId, 'jpg');
      const uploadUrl = await createPresignedUploadUrl(storageClient, PRODUCT_IMAGES_BUCKET, key, 'image/jpeg');
      const realJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: realJpegBytes });
      return productId;
    },
    buildInput: (resourceId, organizationId) => ({
      productId: resourceId,
      key: buildProductImageKey(organizationId, resourceId, 'jpg'),
    }),
  },
];
