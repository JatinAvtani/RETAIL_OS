import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from './schema/index';
import { productVariants, products, stockLevels, stockMovements, units } from './schema/index';
import { createScopedDb } from './tenant-repository';
import { StockLevelRepository } from './repositories/stock-level-repository';
import { ProductRepository } from './repositories/product-repository';
import { setUpTwoTenants, type TwoTenantFixture } from './test-support/tenant-fixture';
import { findStockLevelDrift } from './reconciliation';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('findStockLevelDrift', () => {
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

  it('reports no drift when the projection was maintained transactionally via recordAndProject', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    await repo.recordAndProject({
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
    await repo.recordAndProject({
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

    const adminDb = drizzle(adminClient, { schema });
    const drift = await findStockLevelDrift(adminDb);

    expect(drift.find((d) => d.storeId === fixture.tenantA.storeId && d.variantId === variantAId)).toBeUndefined();
  });

  it('detects real drift when a stock_levels row is hand-edited to disagree with the ledger (bypassing recordAndProject)', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    await repo.recordAndProject({
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

    // Corrupt the projection directly, exactly the kind of drift recordAndProject's transactional
    // discipline is supposed to prevent — this is what a real bug elsewhere in the system would
    // look like from reconciliation's point of view.
    const adminDb = drizzle(adminClient, { schema });
    await adminDb
      .update(stockLevels)
      .set({ quantity: '999.000000' })
      .where(eq(stockLevels.variantId, variantAId));

    const drift = await findStockLevelDrift(adminDb);
    const found = drift.find((d) => d.storeId === fixture.tenantA.storeId && d.variantId === variantAId);

    expect(found).toBeDefined();
    expect(found?.ledgerSum).toBe('20.000000');
    expect(found?.projectionQuantity).toBe('999.000000');
    expect(found?.organizationId).toBe(fixture.tenantA.organizationId);
  });

  it('a stock_levels row with no matching stock_movements at all is caught as drift (the FULL OUTER JOIN case)', async () => {
    const adminDb = drizzle(adminClient, { schema });
    // Insert a projection row directly with no corresponding ledger entries — impossible via
    // recordAndProject, but not impossible via a hand-edited row or a bug in a future code path.
    // A one-sided LEFT JOIN from stock_movements would miss this entirely, since no ledger row
    // exists to anchor the group — this is exactly why the query is a FULL OUTER JOIN.
    await adminDb.insert(stockLevels).values({
      organizationId: fixture.tenantA.organizationId,
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      quantity: '50.000000',
    });

    const drift = await findStockLevelDrift(adminDb);
    const found = drift.find((d) => d.variantId === variantAId);

    expect(found).toBeDefined();
    expect(found?.ledgerSum).toBe('0');
    expect(found?.projectionQuantity).toBe('50.000000');
  });

  it('cross-tenant: drift in tenant B never appears when reconciling, and tenant A drift is correctly attributed to tenant A', async () => {
    const repoA = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const repoB = new StockLevelRepository(createScopedDb(client), fixture.tenantB.organizationId);

    await repoA.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'RECEIPT',
      quantity: '15.000000',
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
      quantity: '25.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const adminDb = drizzle(adminClient, { schema });
    await adminDb
      .update(stockLevels)
      .set({ quantity: '1.000000' })
      .where(eq(stockLevels.variantId, variantAId));

    const drift = await findStockLevelDrift(adminDb);
    const driftA = drift.find((d) => d.variantId === variantAId);
    const driftB = drift.find((d) => d.variantId === variantBId);

    expect(driftA?.organizationId).toBe(fixture.tenantA.organizationId);
    expect(driftB).toBeUndefined();
  });
});
