import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { productVariants, products, stockMovements, units } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { StockMovementRepository } from './stock-movement-repository';
import { ProductRepository } from './product-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('StockMovementRepository cross-tenant isolation', () => {
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

  it("never returns tenant B's movement when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoB = new StockMovementRepository(db, fixture.tenantB.organizationId);
    await repoB.record({
      id: generateId(),
      storeId: fixture.tenantB.storeId,
      productId: productBId,
      variantId: variantBId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const repoA = new StockMovementRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findByStoreAndVariant(fixture.tenantB.storeId, variantBId);

    expect(result).toEqual([]);
  });

  it("tenant A cannot read tenant B's movement even by variant id shared through findByStoreAndVariant", async () => {
    const db = createScopedDb(client);
    const repoA = new StockMovementRepository(db, fixture.tenantA.organizationId);
    const repoB = new StockMovementRepository(db, fixture.tenantB.organizationId);
    const ownId = generateId();
    const otherId = generateId();

    await repoA.record({
      id: ownId,
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });
    await repoB.record({
      id: otherId,
      storeId: fixture.tenantB.storeId,
      productId: productBId,
      variantId: variantBId,
      movementType: 'RECEIPT',
      quantity: '20.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const result = await repoA.findByStoreAndVariant(fixture.tenantA.storeId, variantAId);

    expect(result.map((m) => m.id)).toEqual([ownId]);
    expect(result.some((m) => m.id === otherId)).toBe(false);
  });

  it('the same idempotency key is independently usable by two different tenants', async () => {
    const db = createScopedDb(client);
    const repoA = new StockMovementRepository(db, fixture.tenantA.organizationId);
    const repoB = new StockMovementRepository(db, fixture.tenantB.organizationId);
    const occurredAt = new Date();
    const key = `shared-key-${generateId()}`;

    await expect(
      repoA.record({
        id: generateId(),
        storeId: fixture.tenantA.storeId,
        productId: productAId,
        variantId: variantAId,
        movementType: 'RECEIPT',
        quantity: '1.000000',
        currency: 'USD',
        occurredAt,
        sourceType: 'pos-sync',
        idempotencyKey: key,
      })
    ).resolves.toBeDefined();

    await expect(
      repoB.record({
        id: generateId(),
        storeId: fixture.tenantB.storeId,
        productId: productBId,
        variantId: variantBId,
        movementType: 'RECEIPT',
        quantity: '1.000000',
        currency: 'USD',
        occurredAt,
        sourceType: 'pos-sync',
        idempotencyKey: key,
      })
    ).resolves.toBeDefined();
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new StockMovementRepository(db, '')).toThrow(/organizationId/);
  });
});
