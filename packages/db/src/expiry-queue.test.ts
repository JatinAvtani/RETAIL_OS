import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from './schema/index';
import { lots, productVariants, products, stockLevels, stockMovements, units } from './schema/index';
import { createScopedDb } from './tenant-repository';
import { StockLevelRepository } from './repositories/stock-level-repository';
import { LotRepository } from './repositories/lot-repository';
import { ProductRepository } from './repositories/product-repository';
import { setUpTwoTenants, type TwoTenantFixture } from './test-support/tenant-fixture';
import { findExpiryQueue } from './expiry-queue';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const NOW = new Date('2026-08-04T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const daysFromNow = (n: number) => {
  const d = new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
};

describe('findExpiryQueue', () => {
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
    await adminDb.delete(lots).where(eq(lots.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(lots).where(eq(lots.organizationId, fixture.tenantB.organizationId));
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

  it('reports a lot whose consumption cover exceeds its remaining days to expiry', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const lot = await lotRepo.receive({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: daysAgo(20),
      expiryDate: daysFromNow(5), // 5 days left
      initialQuantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });

    // 30 units consumed over the trailing 30 days -> avg 1/day -> cover = 100/1 = 100 days,
    // far more than the 5 days left before expiry.
    const stockRepo = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    await stockRepo.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-30.000000',
      currency: 'USD',
      occurredAt: daysAgo(10),
      sourceType: 'pos-sync',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findExpiryQueue(adminDb, NOW);
    const found = results.find((r) => r.lotId === lot.id);

    expect(found).toBeDefined();
    expect(found?.daysToExpiry).toBe(5);
    expect(found?.valueAtRisk).toBe('200.0000000000'); // 100 * 2.0000, numeric(19,6) * numeric(19,4)
    expect(found?.avgDailyConsumption).toBe('1.00000000000000000000');
  });

  it('does not report a lot that will genuinely be consumed before it expires', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const lot = await lotRepo.receive({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: daysAgo(5),
      expiryDate: daysFromNow(60), // plenty of time
      initialQuantity: '10.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });

    // 30 units/30 days = 1/day -> cover = 10 days, well under the 60 days left.
    const stockRepo = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    await stockRepo.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-30.000000',
      currency: 'USD',
      occurredAt: daysAgo(10),
      sourceType: 'pos-sync',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findExpiryQueue(adminDb, NOW);
    expect(results.find((r) => r.lotId === lot.id)).toBeUndefined();
  });

  it('treats a lot with zero consumption history in the window as at-risk (I7 — no signal is not evidence of safety)', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const lot = await lotRepo.receive({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: daysAgo(1),
      expiryDate: daysFromNow(90),
      initialQuantity: '5.000000',
      unitCost: '3.0000',
      currency: 'USD',
    });

    // No SALE_CONSUMPTION movements at all for this product.
    const adminDb = drizzle(adminClient, { schema });
    const results = await findExpiryQueue(adminDb, NOW);
    const found = results.find((r) => r.lotId === lot.id);

    expect(found).toBeDefined();
    expect(found?.consumptionCoverDays).toBeNull();
    expect(found?.avgDailyConsumption).toBe('0');
  });

  it('excludes consumption from more than 30 days ago from the average', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const lot = await lotRepo.receive({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: daysAgo(45),
      expiryDate: daysFromNow(90),
      initialQuantity: '5.000000',
      unitCost: '3.0000',
      currency: 'USD',
    });

    // Entirely outside the 30-day window -> should not count, so this behaves like zero
    // consumption (at-risk, since real remaining quantity + a real expiry date + no in-window
    // signal).
    const stockRepo = new StockLevelRepository(createScopedDb(client), fixture.tenantA.organizationId);
    await stockRepo.recordAndProject({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-1000.000000',
      currency: 'USD',
      occurredAt: daysAgo(40),
      sourceType: 'pos-sync',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findExpiryQueue(adminDb, NOW);
    const found = results.find((r) => r.lotId === lot.id);

    expect(found).toBeDefined();
    expect(found?.avgDailyConsumption).toBe('0');
  });

  it('excludes a lot with no expiry date at all, even with real remaining quantity and no consumption', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const lot = await lotRepo.receive({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: daysAgo(1),
      // no expiryDate
      initialQuantity: '5.000000',
      unitCost: '3.0000',
      currency: 'USD',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findExpiryQueue(adminDb, NOW);
    expect(results.find((r) => r.lotId === lot.id)).toBeUndefined();
  });

  it('excludes a DEPLETED lot even if it has a near-term expiry date', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const lot = await lotRepo.receive({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: daysAgo(10),
      expiryDate: daysFromNow(1),
      initialQuantity: '5.000000',
      unitCost: '3.0000',
      currency: 'USD',
    });
    await lotRepo.draw(lot.id, '5.000000'); // fully depletes -> status becomes DEPLETED

    const adminDb = drizzle(adminClient, { schema });
    const results = await findExpiryQueue(adminDb, NOW);
    expect(results.find((r) => r.lotId === lot.id)).toBeUndefined();
  });

  it('ranks multiple at-risk lots by value at risk, descending', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const lowValueLot = await lotRepo.receive({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: daysAgo(1),
      expiryDate: daysFromNow(2),
      initialQuantity: '5.000000',
      unitCost: '1.0000', // value at risk: 5.00
      currency: 'USD',
    });
    const highValueLot = await lotRepo.receive({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: daysAgo(1),
      expiryDate: daysFromNow(3),
      initialQuantity: '50.000000',
      unitCost: '10.0000', // value at risk: 500.00
      currency: 'USD',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findExpiryQueue(adminDb, NOW);
    const ids = results.map((r) => r.lotId).filter((id) => id === lowValueLot.id || id === highValueLot.id);

    expect(ids).toEqual([highValueLot.id, lowValueLot.id]);
  });

  it('cross-tenant: an at-risk lot in tenant B never appears attributed to tenant A, and vice versa', async () => {
    const lotRepoA = new LotRepository(createScopedDb(client), fixture.tenantA.organizationId);
    const lotRepoB = new LotRepository(createScopedDb(client), fixture.tenantB.organizationId);
    const lotA = await lotRepoA.receive({
      id: generateId(),
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: daysAgo(1),
      expiryDate: daysFromNow(1),
      initialQuantity: '5.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });
    const lotB = await lotRepoB.receive({
      id: generateId(),
      storeId: fixture.tenantB.storeId,
      productId: productBId,
      variantId: variantBId,
      receivedAt: daysAgo(1),
      expiryDate: daysFromNow(1),
      initialQuantity: '7.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findExpiryQueue(adminDb, NOW);
    const foundA = results.find((r) => r.lotId === lotA.id);
    const foundB = results.find((r) => r.lotId === lotB.id);

    expect(foundA?.organizationId).toBe(fixture.tenantA.organizationId);
    expect(foundB?.organizationId).toBe(fixture.tenantB.organizationId);
  });
});
