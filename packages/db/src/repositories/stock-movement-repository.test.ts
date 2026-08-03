import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { organizations, productVariants, products, stockMovements, stores, units } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { StockMovementRepository } from './stock-movement-repository';
import { ProductRepository } from './product-repository';
import { withTenantContext } from '../tenant-context';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('StockMovementRepository', () => {
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
      name: 'Stock Movement Test Org',
      slug: `stock-movement-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({
      id: storeId,
      organizationId,
      name: 'Main Store',
      timezone: 'America/New_York',
    });

    // A real global unit row, not a fixed literal — units seeded by the app's own migration are
    // shared across the whole test database, so this test looks one up rather than inserting a
    // duplicate 'g' and risking a code-uniqueness collision with seed data.
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
    const variants = await productRepo.findVariants(productId);
    const defaultVariant = variants[0];
    if (!defaultVariant) throw new Error('Test setup: product has no default variant.');
    variantId = defaultVariant.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
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

  it('records a real movement and returns the inserted row', async () => {
    const repo = new StockMovementRepository(createScopedDb(client), organizationId);
    const id = generateId();
    const occurredAt = new Date();

    const created = await repo.record({
      id,
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '1000.000000',
      unitCost: '0.0030',
      currency: 'USD',
      occurredAt,
      sourceType: 'manual',
    });

    expect(created.id).toBe(id);
    expect(created.movementType).toBe('RECEIPT');
    expect(created.quantity).toBe('1000.000000');
    expect(created.organizationId).toBe(organizationId);
  });

  it('records a movement with unknown cost as null, never zero (I7)', async () => {
    const repo = new StockMovementRepository(createScopedDb(client), organizationId);
    const created = await repo.record({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'COUNT_ADJUSTMENT',
      quantity: '-5.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'stocktake',
    });

    expect(created.unitCost).toBeNull();
  });

  it('preserves a signed negative quantity (consumption/waste move stock down)', async () => {
    const repo = new StockMovementRepository(createScopedDb(client), organizationId);
    const created = await repo.record({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'WASTE',
      quantity: '-25.500000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
      reasonCode: 'SPILLAGE',
    });

    expect(created.quantity).toBe('-25.500000');
    expect(created.reasonCode).toBe('SPILLAGE');
  });

  it('bi-temporal: occurredAt and recordedAt are independent — a backdated entry keeps its business time', async () => {
    const repo = new StockMovementRepository(createScopedDb(client), organizationId);
    const backdated = new Date('2026-01-06T09:00:00Z'); // a Monday
    const created = await repo.record({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      currency: 'USD',
      occurredAt: backdated,
      sourceType: 'manual',
    });

    expect(created.occurredAt.toISOString()).toBe(backdated.toISOString());
    // recordedAt defaults to "now" (whenever this test actually runs), independent of occurredAt.
    expect(created.recordedAt.getTime()).toBeGreaterThan(backdated.getTime());
  });

  it('findByStoreAndVariant returns movements newest-occurred-first', async () => {
    const repo = new StockMovementRepository(createScopedDb(client), organizationId);
    const older = new Date('2026-08-01T10:00:00Z');
    const newer = new Date('2026-08-02T10:00:00Z');
    const olderId = generateId();
    const newerId = generateId();

    await repo.record({
      id: olderId,
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '5.000000',
      currency: 'USD',
      occurredAt: older,
      sourceType: 'manual',
    });
    await repo.record({
      id: newerId,
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '5.000000',
      currency: 'USD',
      occurredAt: newer,
      sourceType: 'manual',
    });

    const result = await repo.findByStoreAndVariant(storeId, variantId);
    expect(result.map((m) => m.id)).toEqual([newerId, olderId]);
  });

  it('the idempotency key prevents a duplicate insert within the same organization', async () => {
    const repo = new StockMovementRepository(createScopedDb(client), organizationId);
    const occurredAt = new Date();
    const key = `idem-${generateId()}`;

    await repo.record({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '1.000000',
      currency: 'USD',
      occurredAt,
      sourceType: 'pos-sync',
      idempotencyKey: key,
    });

    await expect(
      repo.record({
        id: generateId(),
        storeId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '1.000000',
        currency: 'USD',
        occurredAt,
        sourceType: 'pos-sync',
        idempotencyKey: key,
      })
    ).rejects.toThrow();
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new StockMovementRepository(db, '')).toThrow(/organizationId/);
  });

  describe('append-only (I3)', () => {
    it('the application role cannot UPDATE a movement — rejected by the database, not application code', async () => {
      const repo = new StockMovementRepository(createScopedDb(client), organizationId);
      const id = generateId();
      await repo.record({
        id,
        storeId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '1.000000',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'manual',
      });

      const appDb = createScopedDb(client);
      await expect(
        appDb.transaction((tx) =>
          withTenantContext(tx, organizationId, () =>
            tx.update(stockMovements).set({ quantity: '999.000000' }).where(eq(stockMovements.id, id))
          )
        )
      ).rejects.toThrow(/permission denied/);
    });

    it('the application role cannot DELETE a movement — rejected by the database, not application code', async () => {
      const repo = new StockMovementRepository(createScopedDb(client), organizationId);
      const id = generateId();
      await repo.record({
        id,
        storeId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '1.000000',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'manual',
      });

      const appDb = createScopedDb(client);
      await expect(
        appDb.transaction((tx) =>
          withTenantContext(tx, organizationId, () => tx.delete(stockMovements).where(eq(stockMovements.id, id)))
        )
      ).rejects.toThrow(/permission denied/);
    });
  });
});
