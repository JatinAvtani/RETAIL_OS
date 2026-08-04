import {
  createDb,
  categories,
  lots,
  products,
  productVariants,
  recipeComponents,
  recipes,
  storageLocations,
  stores,
  units,
  StockCountService,
} from '@retailos/db';
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

/** Seeds a real store — the same shape as the `stores.get` entry below, factored out since 005-16's endpoints are all store-scoped too. */
const seedStore = async (db: Db, organizationId: string): Promise<string> => {
  const storeId = generateId();
  await db.insert(stores).values({
    id: storeId,
    organizationId,
    name: `Cross-tenant probe store ${storeId}`,
    timezone: 'America/New_York',
  });
  return storeId;
};

/** Seeds a real store + product + default variant together — the shape every 005-16 inventory endpoint needs (they're store-scoped, not just product-scoped). Returns the store id, since `assertStoreAccess` is always the FIRST check these procedures run — attacking with tenant A's storeId is the actual cross-tenant surface being tested, exactly as it is for `stores.get` itself. `seedProduct` (a plain raw insert, written for entries that never needed a variant) does NOT insert a `product_variants` row — the real `ProductRepository.create` does that as its own invariant, but this registry seeds fixtures directly rather than through the repository, so the variant is inserted explicitly here. */
const seedStoreAndProduct = async (
  db: Db,
  organizationId: string
): Promise<{ storeId: string; productId: string; variantId: string }> => {
  const storeId = await seedStore(db, organizationId);
  const productId = await seedProduct(db, organizationId);
  const variantId = generateId();
  await db.insert(productVariants).values({ id: variantId, productId, name: 'Cross-tenant probe variant', isDefault: true });
  return { storeId, productId, variantId };
};

/** Seeds a store + product + variant + a real ACTIVE lot with stock — what `inventory.logWaste`/`logWasteFromLot`'s "own resource" case genuinely needs to succeed (waste logging draws from `lots`, not merely from a product's existence). */
const seedStoreProductWithLot = async (
  db: Db,
  organizationId: string
): Promise<{ storeId: string; productId: string; variantId: string; lotId: string }> => {
  const { storeId, productId, variantId } = await seedStoreAndProduct(db, organizationId);
  const lotId = generateId();
  await db.insert(lots).values({
    id: lotId,
    organizationId,
    storeId,
    productId,
    variantId,
    receivedAt: new Date(),
    initialQuantity: '10.000000',
    remainingQuantity: '10.000000',
    unitCost: '1.0000',
    currency: 'USD',
    status: 'ACTIVE',
  });
  return { storeId, productId, variantId, lotId };
};

/** Seeds a real, one-line DRAFT stock count in tenant A's own store. */
const seedStockCount = async (db: Db, organizationId: string): Promise<string> => {
  const { storeId, productId, variantId } = await seedStoreAndProduct(db, organizationId);
  const service = new StockCountService(db, organizationId);
  const count = await service.createCount({
    storeId,
    scope: 'full',
    productVariantPairs: [{ productId, variantId }],
  });
  return count.id;
};

/** Seeds a real, one-line DRAFT stock count and returns its single line's id — for `setLineReason`, which is scoped by `stockCountLineId`, not `stockCountId`, and doesn't require any particular count status. */
const seedStockCountLine = async (db: Db, organizationId: string): Promise<string> => {
  const { storeId, productId, variantId } = await seedStoreAndProduct(db, organizationId);
  const service = new StockCountService(db, organizationId);
  const count = await service.createCount({
    storeId,
    scope: 'full',
    productVariantPairs: [{ productId, variantId }],
  });
  const lines = await service.findLines(count.id);
  if (!lines[0]) {
    throw new Error('Cross-tenant registry: seeded stock count has no line — createCount invariant broken?');
  }
  return lines[0].id;
};

/** Seeds a stock count already started (IN_PROGRESS) — the real starting state `submit` (and `enterCount`, which submit's own test needs anyway) require. `start` itself is tested against a plain DRAFT count from `seedStockCount`, since DRAFT is exactly what `start` needs to succeed. */
const seedInProgressStockCount = async (db: Db, organizationId: string): Promise<string> => {
  const countId = await seedStockCount(db, organizationId);
  const service = new StockCountService(db, organizationId);
  await service.startCount(countId);
  return countId;
};

/** Seeds a stock count IN_PROGRESS with every line already counted (at exactly its frozen theoretical quantity, so variance is zero) — the real starting state `submit` requires: `submitCount` throws a plain Error if any line's `countedQuantity` is still null, which a bare `startCount`-only fixture would trigger regardless of who's calling. */
const seedInProgressStockCountFullyCounted = async (db: Db, organizationId: string): Promise<string> => {
  const countId = await seedInProgressStockCount(db, organizationId);
  const service = new StockCountService(db, organizationId);
  const lines = await service.findLines(countId);
  for (const line of lines) {
    await service.enterCount(line.id, line.theoreticalQuantityT0 ?? '0');
  }
  return countId;
};

/** Seeds a stock count already submitted (SUBMITTED) — the real starting state `approve`/`reject` require. Every line is counted at exactly its frozen theoretical quantity, so variance is zero and approval never hits the large-variance-needs-a-reason path — this entry is testing the cross-tenant guard, not that specific business rule (which `inventory-business-logic.test.ts` already covers directly). */
const seedSubmittedStockCount = async (db: Db, organizationId: string): Promise<string> => {
  const countId = await seedInProgressStockCountFullyCounted(db, organizationId);
  const service = new StockCountService(db, organizationId);
  await service.submitCount(countId);
  return countId;
};

/** Seeds a stock count already started, and returns its single line's id — the real starting state `enterCount` needs (a DRAFT count's lines have no `theoreticalQuantityT0` snapshot yet, but `enterCount` itself doesn't require IN_PROGRESS specifically; this just matches the realistic flow). */
const seedInProgressStockCountLine = async (db: Db, organizationId: string): Promise<string> => {
  const countId = await seedInProgressStockCount(db, organizationId);
  const service = new StockCountService(db, organizationId);
  const lines = await service.findLines(countId);
  if (!lines[0]) {
    throw new Error('Cross-tenant registry: seeded stock count has no line — createCount invariant broken?');
  }
  return lines[0].id;
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
  {
    // Attacks with tenant A's storeId — assertStoreAccess (canAccessStore) is the FIRST check
    // every 005-16 inventory endpoint runs, before any product/variant lookup, so this is the
    // real cross-tenant surface being tested here, same shape as stores.get itself.
    path: 'inventory.levels',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    path: 'inventory.movements',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreAndProduct(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      const [variant] = product
        ? await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, product.id))
        : [undefined];
      return { storeId: resourceId, productId: product?.id ?? generateId(), variantId: variant?.id ?? generateId() };
    },
  },
  {
    path: 'inventory.lots',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreAndProduct(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      return { storeId: resourceId, productId: product?.id ?? generateId() };
    },
  },
  {
    path: 'inventory.logWaste',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreProductWithLot(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      const [variant] = product
        ? await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, product.id))
        : [undefined];
      return {
        storeId: resourceId,
        productId: product?.id ?? generateId(),
        variantId: variant?.id ?? generateId(),
        quantity: '1.000000',
        reasonCode: 'SPILLAGE',
      };
    },
  },
  {
    path: 'inventory.logWasteFromLot',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreProductWithLot(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      const [variant] = product
        ? await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, product.id))
        : [undefined];
      const [lot] = product
        ? await db.select({ id: lots.id }).from(lots).where(eq(lots.productId, product.id))
        : [undefined];
      return {
        storeId: resourceId,
        productId: product?.id ?? generateId(),
        variantId: variant?.id ?? generateId(),
        lotId: lot?.id ?? generateId(),
        quantity: '1.000000',
        reasonCode: 'SPILLAGE',
      };
    },
  },
  {
    // createFull's real cross-tenant risk is attacking with tenant A's storeId — but the "own
    // resource" positive-case test requires a genuine 200, which means tenant A needs a REAL
    // product/variant pair to count, not a fake generateId() placeholder (that would 500, a
    // legitimate rejection of a nonexistent product, not proof the store guard works).
    path: 'stocktake.createFull',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreAndProduct(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      const [variant] = product
        ? await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, product.id))
        : [undefined];
      return {
        storeId: resourceId,
        productVariantPairs: [{ productId: product!.id, variantId: variant!.id }],
      };
    },
  },
  {
    // Same reasoning as createFull: the "own resource" case needs a REAL category with a REAL
    // product in it, not a fake id — createCountByCategory throws EmptyCountScopeError (a genuine
    // BAD_REQUEST, not proof of a cross-tenant guard) against a category with nothing in it.
    path: 'stocktake.createByCategory',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId, productId } = await seedStoreAndProduct(db, organizationId);
      const categoryId = await seedCategory(db, organizationId);
      await db.update(products).set({ categoryId }).where(eq(products.id, productId));
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db
        .select({ categoryId: products.categoryId })
        .from(products)
        .where(eq(products.organizationId, organizationId));
      return { storeId: resourceId, categoryId: product!.categoryId! };
    },
  },
  {
    // Same reasoning again, for storage locations.
    path: 'stocktake.createByStorageLocation',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId, productId } = await seedStoreAndProduct(db, organizationId);
      const storageLocationId = generateId();
      await db.insert(storageLocations).values({
        id: storageLocationId,
        organizationId,
        storeId,
        name: `Cross-tenant probe location ${storageLocationId}`,
      });
      await db.update(products).set({ storageLocationId }).where(eq(products.id, productId));
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db
        .select({ storageLocationId: products.storageLocationId })
        .from(products)
        .where(eq(products.organizationId, organizationId));
      return { storeId: resourceId, storageLocationId: product!.storageLocationId! };
    },
  },
  {
    path: 'stocktake.get',
    type: 'query',
    seedResource: seedStockCount,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    path: 'stocktake.start',
    type: 'mutation',
    seedResource: seedStockCount,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    // The "own resource" case needs a count already IN_PROGRESS with every line counted — submit
    // rejects a DRAFT count (wrong status) or an IN_PROGRESS-but-uncounted one (an incomplete
    // count) regardless of who's calling, neither of which is proof the cross-tenant guard works.
    path: 'stocktake.submit',
    type: 'mutation',
    seedResource: seedInProgressStockCountFullyCounted,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    // Same reasoning: approve/reject both need a count already SUBMITTED.
    path: 'stocktake.approve',
    type: 'mutation',
    seedResource: seedSubmittedStockCount,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    path: 'stocktake.reject',
    type: 'mutation',
    seedResource: seedSubmittedStockCount,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    path: 'stocktake.enterCount',
    type: 'mutation',
    seedResource: seedInProgressStockCountLine,
    buildInput: (resourceId) => ({ stockCountLineId: resourceId, countedQuantity: '1.000000' }),
  },
  {
    path: 'stocktake.setLineReason',
    type: 'mutation',
    seedResource: seedStockCountLine,
    buildInput: (resourceId) => ({ stockCountLineId: resourceId, reasonCode: 'Cross-tenant probe' }),
  },
];
