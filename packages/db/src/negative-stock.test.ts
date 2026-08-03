import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from './schema/index';
import { productVariants, products, stockLevels, stockMovements, units } from './schema/index';
import { createScopedDb } from './tenant-repository';
import { StockLevelRepository } from './repositories/stock-level-repository';
import { ProductRepository } from './repositories/product-repository';
import { setUpTwoTenants, type TwoTenantFixture } from './test-support/tenant-fixture';
import { findNegativeStock } from './negative-stock';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('findNegativeStock', () => {
  let fixture: TwoTenantFixture;
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let unitId: string;
  let productAId: string;
  let variantAId: string;
  let productBId: string;
  let variantBId: string;

  beforeAll(async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    const existingUnit = await adminDb.select().from(units).where(eq(units.code, 'g'));
    unitId = existingUnit[0]?.id ?? generateId();
    if (!existingUnit[0]) {
      await adminDb.insert(units).values({ id: unitId, code: 'g', dimension: 'MASS', isBase: true });
    }

    const repoA = new ProductRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const productA = await repoA.create({
      id: generateId(),
      sku: `SKU-A-${generateId()}`,
      name: 'Tenant A Flour',
      baseUnitId: unitId,
      type: 'INGREDIENT',
    });
    productAId = productA.id;
    variantAId = (await repoA.findVariants(productAId))[0]!.id;

    const repoB = new ProductRepository(createScopedDb(client), fixture.tenantB.organizationId);
    const productB = await repoB.create({
      id: generateId(),
      sku: `SKU-B-${generateId()}`,
      name: 'Tenant B Flour',
      baseUnitId: unitId,
      type: 'INGREDIENT',
    });
    productBId = productB.id;
    variantBId = (await repoB.findVariants(productBId))[0]!.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, fixture.tenantB.organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, fixture.tenantB.organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(productVariants).where(eq(productVariants.productId, productAId));
    await adminDb.delete(productVariants).where(eq(productVariants.productId, productBId));
    await adminDb.delete(products).where(eq(products.id, productAId));
    await adminDb.delete(products).where(eq(products.id, productBId));
    await client.end();
    await adminClient.end();
    await fixture.cleanup();
  });

  it('reports a product/variant whose stock_levels.quantity has genuinely gone negative', async () => {
    const stockRepo = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    // A real negative-stock scenario: two consumption movements exceeding what was ever received
    // (a missed receipt, per plan.md's own explanation of what negative stock signals).
    await stockRepo.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-5.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findNegativeStock(adminDb);
    const found = results.find((r) => r.variantId === variantAId);

    expect(found).toBeDefined();
    expect(found?.quantityOnHand).toBe('-5.000000');
    expect(found?.organizationId).toBe(fixture.tenantA.organizationId);
  });

  it('does not report a product with positive stock', async () => {
    const stockRepo = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    await stockRepo.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'RECEIPT',
      quantity: '20.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findNegativeStock(adminDb);
    expect(results.find((r) => r.variantId === variantAId)).toBeUndefined();
  });

  it('does not report a product with exactly zero stock (the boundary is exclusive — only genuinely negative counts)', async () => {
    const stockRepo = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    await stockRepo.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });
    await stockRepo.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-10.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findNegativeStock(adminDb);
    expect(results.find((r) => r.variantId === variantAId)).toBeUndefined();
  });

  it('cross-tenant: negative stock in tenant B never appears attributed to tenant A, and vice versa', async () => {
    const stockRepoA = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const stockRepoB = new StockLevelRepository(createScopedDb(client), fixture.tenantB.organizationId);
    await stockRepoA.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-3.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });
    await stockRepoB.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantB.storeId,
      productId: productBId,
      variantId: variantBId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-7.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findNegativeStock(adminDb);
    const foundA = results.find((r) => r.variantId === variantAId);
    const foundB = results.find((r) => r.variantId === variantBId);

    expect(foundA?.organizationId).toBe(fixture.tenantA.organizationId);
    expect(foundA?.quantityOnHand).toBe('-3.000000');
    expect(foundB?.organizationId).toBe(fixture.tenantB.organizationId);
    expect(foundB?.quantityOnHand).toBe('-7.000000');
  });
});
