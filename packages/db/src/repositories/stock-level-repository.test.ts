import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { organizations, productVariants, products, stockLevels, stockMovements, stores, units } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { StockLevelRepository } from './stock-level-repository';
import { ProductRepository } from './product-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('StockLevelRepository', () => {
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
      name: 'Stock Level Test Org',
      slug: `stock-level-test-${organizationId}`,
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
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
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

  it('a first RECEIPT creates the projection row with quantity and avgUnitCost equal to the movement', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), organizationId);
    const { movement, projection } = await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '2.5000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    expect(movement.quantity).toBe('100.000000');
    expect(projection.quantity).toBe('100.000000');
    expect(projection.avgUnitCost).toBe('2.5000');
  });

  it('a second RECEIPT at a different cost recomputes avgUnitCost with the weighted-average formula', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), organizationId);
    await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });
    // (2.00*10 + 4.00*10) / 20 = 3.00
    const { projection } = await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      unitCost: '4.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    expect(projection.quantity).toBe('20.000000');
    expect(projection.avgUnitCost).toBe('3.0000');
  });

  it('SALE_CONSUMPTION reduces quantity but leaves avgUnitCost unchanged', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), organizationId);
    await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '20.000000',
      unitCost: '3.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const { projection } = await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-5.000000',
      unitCost: '3.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });

    expect(projection.quantity).toBe('15.000000');
    expect(projection.avgUnitCost).toBe('3.0000');
  });

  it('a movement with unitCost unknown (null) never changes avgUnitCost, even on a RECEIPT (I7)', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), organizationId);
    await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      unitCost: '5.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const { projection } = await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    expect(projection.quantity).toBe('20.000000');
    expect(projection.avgUnitCost).toBe('5.0000');
  });

  it('avgUnitCost stays null until the first movement with a known cost arrives (I7 — never defaults to 0)', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), organizationId);
    const { projection: afterUnknown } = await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'COUNT_ADJUSTMENT',
      quantity: '10.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'stocktake',
    });
    expect(afterUnknown.avgUnitCost).toBeNull();

    const { projection: afterKnown } = await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      unitCost: '1.5000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });
    expect(afterKnown.avgUnitCost).toBe('1.5000');
  });

  it('projection quantity equals the ledger sum across a mixed sequence of movements (the epic acceptance criterion)', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), organizationId);
    const movements: { movementType: 'RECEIPT' | 'SALE_CONSUMPTION' | 'WASTE' | 'COUNT_ADJUSTMENT'; quantity: string; reasonCode?: string }[] = [
      { movementType: 'RECEIPT', quantity: '50.000000' },
      { movementType: 'SALE_CONSUMPTION', quantity: '-12.500000' },
      // A real WASTE movement requires one of the fixed reason codes (005-10's CHECK constraint,
      // stock_movements_waste_reason_code) — this test predates that constraint and needs one now.
      { movementType: 'WASTE', quantity: '-2.000000', reasonCode: 'SPILLAGE' },
      { movementType: 'RECEIPT', quantity: '30.000000' },
      { movementType: 'COUNT_ADJUSTMENT', quantity: '-1.000000' },
    ];

    let lastProjection;
    for (const m of movements) {
      const result = await repo.recordAndProject({
        id: generateId(),
        storeId,
        productId,
        variantId,
        movementType: m.movementType,
        quantity: m.quantity,
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'manual',
        ...(m.reasonCode !== undefined ? { reasonCode: m.reasonCode } : {}),
      });
      lastProjection = result.projection;
    }

    const adminDb = drizzle(adminClient, { schema });
    const ledgerRows = await adminDb
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.organizationId, organizationId));
    const ledgerSum = ledgerRows.reduce((sum, r) => sum + Number(r.quantity), 0);

    expect(Number(lastProjection!.quantity)).toBeCloseTo(ledgerSum, 6);
    expect(lastProjection!.quantity).toBe('64.500000');
  });

  it('find returns null for a store/product/variant combination with no movements yet', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), organizationId);
    const result = await repo.find(storeId, productId, variantId);
    expect(result).toBeNull();
  });

  it('find returns the current projection after movements have been recorded', async () => {
    const repo = new StockLevelRepository(createScopedDb(client), organizationId);
    await repo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '7.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const result = await repo.find(storeId, productId, variantId);
    expect(result?.quantity).toBe('7.000000');
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new StockLevelRepository(db, '')).toThrow(/organizationId/);
  });
});
