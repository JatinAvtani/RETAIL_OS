import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, productVariants, products, stockParLevels, stores, units } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { ParLevelRepository } from './par-level-repository';
import { ProductRepository } from './product-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('ParLevelRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let unitId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Par Level Test Org',
      slug: `par-level-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({
      id: storeId,
      organizationId,
      name: 'Main Store',
      timezone: 'America/New_York',
    });

    const existingUnit = await adminDb.select().from(units).where(eq(units.code, 'g'));
    unitId = existingUnit[0]?.id ?? generateId();
    if (!existingUnit[0]) {
      await adminDb.insert(units).values({ id: unitId, code: 'g', dimension: 'MASS', isBase: true });
    }

    const productRepo = new ProductRepository(createScopedDb(client), organizationId);
    const product = await productRepo.create({
      id: generateId(),
      sku: `SKU-${generateId()}`,
      name: 'Flour',
      baseUnitId: unitId,
      type: 'INGREDIENT',
    });
    productId = product.id;
    variantId = (await productRepo.findVariants(productId))[0]!.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stockParLevels).where(eq(stockParLevels.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(productVariants).where(eq(productVariants.productId, productId));
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('find() returns null when no par level has been set — never a guessed default', async () => {
    const repo = new ParLevelRepository(createScopedDb(client), organizationId);
    const row = await repo.find(storeId, productId, variantId);
    expect(row).toBeNull();
  });

  it('setParLevel() creates a row with both values when both are given', async () => {
    const repo = new ParLevelRepository(createScopedDb(client), organizationId);
    const row = await repo.setParLevel({
      storeId,
      productId,
      variantId,
      parLevel: '50.000000',
      reorderPoint: '20.000000',
    });

    expect(row.parLevel).toBe('50.000000');
    expect(row.reorderPoint).toBe('20.000000');
  });

  it('setParLevel() leaves reorderPoint null when only parLevel is given (I7 — no guessed threshold)', async () => {
    const repo = new ParLevelRepository(createScopedDb(client), organizationId);
    const row = await repo.setParLevel({ storeId, productId, variantId, parLevel: '30.000000' });

    expect(row.parLevel).toBe('30.000000');
    expect(row.reorderPoint).toBeNull();
  });

  it('setParLevel() called twice upserts in place rather than creating a second row', async () => {
    const repo = new ParLevelRepository(createScopedDb(client), organizationId);
    await repo.setParLevel({ storeId, productId, variantId, parLevel: '10.000000' });
    await repo.setParLevel({ storeId, productId, variantId, parLevel: '40.000000', reorderPoint: '15.000000' });

    const row = await repo.find(storeId, productId, variantId);
    expect(row?.parLevel).toBe('40.000000');
    expect(row?.reorderPoint).toBe('15.000000');

    const adminDb = drizzle(adminClient, { schema });
    const allRows = await adminDb.select().from(stockParLevels).where(eq(stockParLevels.organizationId, organizationId));
    expect(allRows).toHaveLength(1);
  });

  it('findAllForStore() returns every configured row for the store', async () => {
    const productRepo = new ProductRepository(createScopedDb(client), organizationId);
    const secondProduct = await productRepo.create({
      id: generateId(),
      sku: `SKU-${generateId()}`,
      name: 'Cheese',
      baseUnitId: unitId,
      type: 'INGREDIENT',
    });
    const secondVariantId = (await productRepo.findVariants(secondProduct.id))[0]!.id;

    const repo = new ParLevelRepository(createScopedDb(client), organizationId);
    await repo.setParLevel({ storeId, productId, variantId, parLevel: '50.000000' });
    await repo.setParLevel({ storeId, productId: secondProduct.id, variantId: secondVariantId, parLevel: '25.000000' });

    const rows = await repo.findAllForStore(storeId);
    expect(rows).toHaveLength(2);

    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stockParLevels).where(eq(stockParLevels.productId, secondProduct.id));
    await adminDb.delete(productVariants).where(eq(productVariants.productId, secondProduct.id));
    await adminDb.delete(products).where(eq(products.id, secondProduct.id));
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(stockParLevels).where(eq(stockParLevels.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(stockParLevels).where(eq(stockParLevels.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A par levels via findAllForStore', async () => {
      const productRepoA = new ProductRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const productA = await productRepoA.create({
        id: generateId(),
        sku: `SKU-${generateId()}`,
        name: 'Tenant A Product',
        baseUnitId: unitId,
        type: 'INGREDIENT',
      });
      const variantA = (await productRepoA.findVariants(productA.id))[0]!.id;

      const repoA = new ParLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
      await repoA.setParLevel({ storeId: fixture.tenantA.storeId, productId: productA.id, variantId: variantA, parLevel: '99.000000' });

      const repoB = new ParLevelRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const rowsForB = await repoB.findAllForStore(fixture.tenantA.storeId);
      expect(rowsForB).toHaveLength(0);

      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(stockParLevels).where(eq(stockParLevels.productId, productA.id));
      await adminDb.delete(productVariants).where(eq(productVariants.productId, productA.id));
      await adminDb.delete(products).where(eq(products.id, productA.id));
    });
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new ParLevelRepository(createScopedDb(client), '')).toThrow();
  });
});
