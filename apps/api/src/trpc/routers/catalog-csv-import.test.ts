import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  createDb,
  hashPassword,
  memberships,
  organizations,
  categories,
  products,
  productVariants,
  suppliers,
  catalogCsvImports,
  savedCatalogCsvColumnMappings,
  users,
  recipes,
  recipeComponents,
  ProductRepository,
  UnitRepository,
} from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildCatalogCsvImportKey } from '@retailos/storage';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string } } };

const asSuccess = (body: TrpcSuccess | TrpcError): TrpcSuccess['result']['data'] => {
  if (!('result' in body)) {
    throw new Error(`Expected a successful tRPC response, got an error: ${JSON.stringify(body)}`);
  }
  return body.result.data;
};

const asError = (body: TrpcSuccess | TrpcError): TrpcError['error'] => {
  if (!('error' in body)) {
    throw new Error(`Expected a tRPC error response, got success: ${JSON.stringify(body)}`);
  }
  return body.error;
};

const PRODUCT_CSV = 'sku,name,unit,type,category\nSKU-1,Flour T55,kg,INGREDIENT,Dry goods\nSKU-2,Whole Milk,l,INGREDIENT,\n';
const PRODUCT_MAPPING = { sku: 'sku', name: 'name', unit: 'unit', type: 'type', category: 'category' };
const SUPPLIER_CSV = 'name,terms\nNova Foods,Net 30\n';
const SUPPLIER_MAPPING = { name: 'name', paymentTerms: 'terms' };

/**
 * Real Postgres + real Redis + real MinIO + real HTTP, mirroring `csv-import.test.ts`'s exact
 * discipline for the new product/supplier catalog CSV importer — org-scoped only, no `storeId`
 * anywhere (unlike sales import), matching `products.create`/`suppliers.create`'s own tenant
 * boundary.
 */
describe('catalogCsvImport router', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      const tokens = await redis.smembers(`user-sessions:${userId}`);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => `session:${t}`), `user-sessions:${userId}`);
      }
      await db.delete(memberships).where(eq(memberships.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    for (const orgId of createdOrgIds) {
      // recipe_components has no organization_id of its own — deleted per-recipe via a join lookup, before products (components FK into products).
      const orgRecipes = await db.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await db.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await db.delete(recipes).where(eq(recipes.organizationId, orgId));
      // productVariants has no organization_id of its own — deleted per-product via a join lookup, matching this project's FK-teardown-order discipline.
      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(categories).where(eq(categories.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));
      await db.delete(savedCatalogCsvColumnMappings).where(eq(savedCatalogCsvColumnMappings.organizationId, orgId));
      await db.delete(catalogCsvImports).where(eq(catalogCsvImports.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdUserIds.length = 0;
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const setUpOrg = async (): Promise<{ organizationId: string; sessionCookie: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Catalog CSV Import Test Org ${organizationId}`,
      slug: `catalog-csv-import-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    const email = uniqueEmail('catalog-csv-import');
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role: 'OWNER', acceptedAt: new Date() });

    const loginResponse = await app.inject({ method: 'POST', url: '/trpc/auth.login', payload: { email, password } });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    return { organizationId, sessionCookie };
  };

  /** Runs the real requestUpload -> real PUT -> confirmUpload sequence. */
  const uploadCsv = async (importType: 'PRODUCT' | 'SUPPLIER' | 'RECIPE', sessionCookie: string, csvText: string) => {
    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.requestUpload',
      payload: { importType },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };

    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: csvText });

    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.confirmUpload',
      payload: { importType, key },
      cookies: { '__Host-session': sessionCookie },
    });
    return { confirmResponse, key };
  };

  it('rejects an unauthenticated requestUpload with 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/trpc/catalogCsvImport.requestUpload', payload: { importType: 'PRODUCT' } });
    expect(response.statusCode).toBe(401);
  });

  it('confirmUpload creates the import row and detects real headers from the uploaded bytes', async () => {
    const { sessionCookie } = await setUpOrg();
    const { confirmResponse } = await uploadCsv('PRODUCT', sessionCookie, PRODUCT_CSV);

    expect(confirmResponse.statusCode).toBe(200);
    const body = asSuccess(confirmResponse.json()) as { importId: string; headers: string[]; sampleRows: string[][] };
    expect(body.headers).toEqual(['sku', 'name', 'unit', 'type', 'category']);

    const [row] = await db.select().from(catalogCsvImports).where(eq(catalogCsvImports.id, body.importId));
    expect(row?.status).toBe('UPLOADED');
    expect(row?.importType).toBe('PRODUCT');
  });

  it('confirmUpload rejects a key not prefixed with the caller\'s own organizationId', async () => {
    const { sessionCookie } = await setUpOrg();
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.confirmUpload',
      payload: { importType: 'PRODUCT', key: buildCatalogCsvImportKey('some-other-org', generateId()) },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('submitColumnMapping moves the import to MAPPED and can save a reusable per-tenant mapping', async () => {
    const { sessionCookie } = await setUpOrg();
    const { confirmResponse } = await uploadCsv('PRODUCT', sessionCookie, PRODUCT_CSV);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

    const mapResponse = await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.submitColumnMapping',
      payload: { importId, columnMapping: PRODUCT_MAPPING, saveAsLabel: 'My product export' },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(mapResponse.statusCode).toBe(200);

    const [row] = await db.select().from(catalogCsvImports).where(eq(catalogCsvImports.id, importId));
    expect(row?.status).toBe('MAPPED');

    const savedResponse = await app.inject({
      method: 'GET',
      url: `/trpc/catalogCsvImport.savedMappings?input=${encodeURIComponent(JSON.stringify({ importType: 'PRODUCT' }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    const saved = asSuccess(savedResponse.json()) as unknown as Array<{ label: string }>;
    expect(saved.some((m) => m.label === 'My product export')).toBe(true);
  });

  it('commit imports products, creating a real default variant per product, and skips an unresolvable unit', async () => {
    const { organizationId, sessionCookie } = await setUpOrg();
    const csv = 'sku,name,unit,type,category\nSKU-1,Flour T55,kg,INGREDIENT,\nSKU-2,Bad Row,lbs,INGREDIENT,\n';
    const { confirmResponse } = await uploadCsv('PRODUCT', sessionCookie, csv);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

    await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.submitColumnMapping',
      payload: { importId, columnMapping: PRODUCT_MAPPING },
      cookies: { '__Host-session': sessionCookie },
    });

    const commitResponse = await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.commit',
      payload: { importId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(commitResponse.statusCode).toBe(200);
    const result = asSuccess(commitResponse.json()) as { totalRowCount: number; importedRowCount: number; skippedRowCount: number };
    expect(result.totalRowCount).toBe(2);
    expect(result.importedRowCount).toBe(1);
    expect(result.skippedRowCount).toBe(1);

    const [product] = await db.select().from(products).where(eq(products.organizationId, organizationId));
    expect(product?.sku).toBe('SKU-1');
    expect(product?.name).toBe('Flour T55');

    const variants = await db.select().from(productVariants).where(eq(productVariants.productId, product!.id));
    expect(variants).toHaveLength(1);
    expect(variants[0]?.isDefault).toBe(true);

    const [row] = await db.select().from(catalogCsvImports).where(eq(catalogCsvImports.id, importId));
    expect(row?.status).toBe('IMPORTED');
  });

  it('commit creates a real category from the CSV category column when it does not already exist', async () => {
    const { organizationId, sessionCookie } = await setUpOrg();
    const { confirmResponse } = await uploadCsv('PRODUCT', sessionCookie, PRODUCT_CSV);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

    /**
     * Both responses are asserted, not discarded. Without this the test reads its own precondition
     * failures as its subject: if mapping or commit fails for any reason, the category query
     * returns nothing and the assertion reports `expected undefined to be 'Dry goods'` — which
     * names the symptom and hides the cause. That is exactly how this failed in CI while passing
     * locally, with no indication of which step actually broke.
     */
    const mappingResponse = await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.submitColumnMapping',
      payload: { importId, columnMapping: PRODUCT_MAPPING },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(mappingResponse.statusCode).toBe(200);

    const commitResponse = await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.commit',
      payload: { importId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(commitResponse.statusCode).toBe(200);

    const [category] = await db.select().from(categories).where(eq(categories.organizationId, organizationId));
    expect(category?.name).toBe('Dry goods');

    /**
     * Scoped to THIS test's organization. Querying by SKU alone matched whichever `SKU-1` the
     * database happened to return first — and several tests in this file create their own `SKU-1`
     * under different orgs, so the row came back from another test's tenant depending on execution
     * order and leftover rows. A tenant-scoped query is what the application layer enforces
     * everywhere (I4); a test that reaches around it can assert against another tenant's data.
     */
    const [flour] = await db
      .select()
      .from(products)
      .where(and(eq(products.organizationId, organizationId), eq(products.sku, 'SKU-1')));
    expect(flour?.categoryId).toBe(category?.id);
  });

  it('commit imports suppliers', async () => {
    const { organizationId, sessionCookie } = await setUpOrg();
    const { confirmResponse } = await uploadCsv('SUPPLIER', sessionCookie, SUPPLIER_CSV);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

    await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.submitColumnMapping',
      payload: { importId, columnMapping: SUPPLIER_MAPPING },
      cookies: { '__Host-session': sessionCookie },
    });

    const commitResponse = await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.commit',
      payload: { importId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(commitResponse.statusCode).toBe(200);
    const result = asSuccess(commitResponse.json()) as { importedRowCount: number };
    expect(result.importedRowCount).toBe(1);

    const [supplier] = await db.select().from(suppliers).where(eq(suppliers.organizationId, organizationId));
    expect(supplier?.name).toBe('Nova Foods');
    expect(supplier?.paymentTerms).toBe('Net 30');
  });

  it('an import\'s importType is fixed at upload time and cannot be changed later', async () => {
    const { sessionCookie } = await setUpOrg();
    const { confirmResponse } = await uploadCsv('PRODUCT', sessionCookie, PRODUCT_CSV);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };
    const [row] = await db.select().from(catalogCsvImports).where(eq(catalogCsvImports.id, importId));
    expect(row?.importType).toBe('PRODUCT');
  });

  it('commit rejects a not-yet-MAPPED import', async () => {
    const { sessionCookie } = await setUpOrg();
    const { confirmResponse } = await uploadCsv('PRODUCT', sessionCookie, PRODUCT_CSV);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

    const commitResponse = await app.inject({
      method: 'POST',
      url: '/trpc/catalogCsvImport.commit',
      payload: { importId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(commitResponse.statusCode).toBe(400);
  });

  it('get rejects a nonexistent import with 404', async () => {
    const { sessionCookie } = await setUpOrg();
    const response = await app.inject({
      method: 'GET',
      url: `/trpc/catalogCsvImport.get?input=${encodeURIComponent(JSON.stringify({ importId: generateId() }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    expect(response.statusCode).toBe(404);
    expect(asError(response.json()).data.code).toBe('NOT_FOUND');
  });

  it('list filters by importType', async () => {
    const { sessionCookie } = await setUpOrg();
    await uploadCsv('PRODUCT', sessionCookie, PRODUCT_CSV);
    await uploadCsv('SUPPLIER', sessionCookie, SUPPLIER_CSV);

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/catalogCsvImport.list?input=${encodeURIComponent(JSON.stringify({ importType: 'SUPPLIER' }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    const rows = asSuccess(response.json()) as unknown as Array<{ importType: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.importType).toBe('SUPPLIER');
  });

  describe('recipe import', () => {
    const RECIPE_MAPPING = {
      recipeName: 'recipe',
      yieldQuantity: 'yield_qty',
      yieldUnit: 'yield_unit',
      componentProductName: 'ingredient',
      componentQuantity: 'ingredient_qty',
      componentUnit: 'ingredient_unit',
    };

    /** Seeds a real product this org's recipe components can resolve by exact name. */
    const seedRealProduct = async (organizationId: string, name: string, sku: string) => {
      const unitRepository = new UnitRepository(db);
      const kg = await unitRepository.findByCode('kg');
      const productRepository = new ProductRepository(db, organizationId);
      await productRepository.create({ id: generateId(), sku, name, baseUnitId: kg!.id, type: 'INGREDIENT' });
    };

    it('commit creates a real recipe + real components when every ingredient resolves to an existing product', async () => {
      const { organizationId, sessionCookie } = await setUpOrg();
      await seedRealProduct(organizationId, 'Flour T55', 'FLOUR-RCP-1');
      await seedRealProduct(organizationId, 'Butter', 'BUTTER-RCP-1');

      const csv =
        'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit\n' +
        'Croissant Dough,12,each,Flour T55,2,kg\n' +
        'Croissant Dough,12,each,Butter,0.8,kg\n';
      const { confirmResponse } = await uploadCsv('RECIPE', sessionCookie, csv);
      const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

      await app.inject({
        method: 'POST',
        url: '/trpc/catalogCsvImport.submitColumnMapping',
        payload: { importId, columnMapping: RECIPE_MAPPING },
        cookies: { '__Host-session': sessionCookie },
      });

      const commitResponse = await app.inject({
        method: 'POST',
        url: '/trpc/catalogCsvImport.commit',
        payload: { importId },
        cookies: { '__Host-session': sessionCookie },
      });
      expect(commitResponse.statusCode).toBe(200);
      const result = asSuccess(commitResponse.json()) as { importedRowCount: number; skippedRowCount: number; skippedGroups: unknown[] };
      expect(result.importedRowCount).toBe(1);
      expect(result.skippedRowCount).toBe(0);
      expect(result.skippedGroups).toHaveLength(0);

      const [recipe] = await db.select().from(recipes).where(eq(recipes.organizationId, organizationId));
      expect(recipe?.name).toBe('Croissant Dough');
      expect(recipe?.yieldQuantity).toBe('12.000000');

      const components = await db.select().from(recipeComponents).where(eq(recipeComponents.recipeId, recipe!.id));
      expect(components).toHaveLength(2);
    });

    it('commit skips a whole recipe group when an ingredient does not match any real product, and reports why', async () => {
      const { sessionCookie } = await setUpOrg();
      const csv = 'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit\nLoaf,1,each,Nonexistent Flour,1,kg\n';
      const { confirmResponse } = await uploadCsv('RECIPE', sessionCookie, csv);
      const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

      await app.inject({
        method: 'POST',
        url: '/trpc/catalogCsvImport.submitColumnMapping',
        payload: { importId, columnMapping: RECIPE_MAPPING },
        cookies: { '__Host-session': sessionCookie },
      });

      const commitResponse = await app.inject({
        method: 'POST',
        url: '/trpc/catalogCsvImport.commit',
        payload: { importId },
        cookies: { '__Host-session': sessionCookie },
      });
      const result = asSuccess(commitResponse.json()) as { importedRowCount: number; skippedGroups: { recipeName: string; reason: string }[] };
      expect(result.importedRowCount).toBe(0);
      expect(result.skippedGroups).toHaveLength(1);
      expect(result.skippedGroups[0]?.recipeName).toBe('Loaf');
      expect(result.skippedGroups[0]?.reason).toContain('Nonexistent Flour');
    });

    it('commit imports the groups that DO fully resolve even when a different group in the same file is skipped', async () => {
      const { organizationId, sessionCookie } = await setUpOrg();
      await seedRealProduct(organizationId, 'Sugar', 'SUGAR-RCP-1');

      const csv =
        'recipe,yield_qty,yield_unit,ingredient,ingredient_qty,ingredient_unit\n' +
        'Simple Syrup,1,l,Sugar,0.5,kg\n' +
        'Broken Recipe,1,each,Nonexistent Ingredient,1,kg\n';
      const { confirmResponse } = await uploadCsv('RECIPE', sessionCookie, csv);
      const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

      await app.inject({
        method: 'POST',
        url: '/trpc/catalogCsvImport.submitColumnMapping',
        payload: { importId, columnMapping: RECIPE_MAPPING },
        cookies: { '__Host-session': sessionCookie },
      });

      const commitResponse = await app.inject({
        method: 'POST',
        url: '/trpc/catalogCsvImport.commit',
        payload: { importId },
        cookies: { '__Host-session': sessionCookie },
      });
      const result = asSuccess(commitResponse.json()) as { importedRowCount: number; skippedGroups: { recipeName: string }[] };
      expect(result.importedRowCount).toBe(1);
      expect(result.skippedGroups.map((g) => g.recipeName)).toEqual(['Broken Recipe']);

      const [recipe] = await db.select().from(recipes).where(eq(recipes.organizationId, organizationId));
      expect(recipe?.name).toBe('Simple Syrup');
    });
  });
});
