import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { productVariants, products, stockLevels, stockMovements, units } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { StockLevelRepository } from './stock-level-repository';
import { ProductRepository } from './product-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('StockLevelRepository cross-tenant isolation', () => {
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

  it("tenant A's find never returns tenant B's projection, even when both use the SAME storeId/productId/variantId shape independently", async () => {
    const db = createScopedDb(client);
    const repoB = new StockLevelRepository(db, fixture.tenantB.organizationId);
    await repoB.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantB.storeId,
      productId: productBId,
      variantId: variantBId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '9.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const repoA = new StockLevelRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.find(fixture.tenantB.storeId, productBId, variantBId);

    expect(result).toBeNull();
  });

  it('two tenants recording movements for their own store/product/variant never see or affect the other\'s projection', async () => {
    const db = createScopedDb(client);
    const repoA = new StockLevelRepository(db, fixture.tenantA.organizationId);
    const repoB = new StockLevelRepository(db, fixture.tenantB.organizationId);

    await repoA.recordAndProject({
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
    await repoB.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantB.storeId,
      productId: productBId,
      variantId: variantBId,
      movementType: 'RECEIPT',
      quantity: '20.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const projectionA = await repoA.find(fixture.tenantA.storeId, productAId, variantAId);
    const projectionB = await repoB.find(fixture.tenantB.storeId, productBId, variantBId);

    expect(projectionA?.quantity).toBe('10.000000');
    expect(projectionB?.quantity).toBe('20.000000');
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new StockLevelRepository(db, '')).toThrow(/organizationId/);
  });
});
