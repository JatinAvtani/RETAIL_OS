import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { lots, organizations, productVariants, products, stores, units } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { LotRepository } from './lot-repository';
import { ProductRepository } from './product-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('LotRepository', () => {
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
      name: 'Lot Test Org',
      slug: `lot-test-${organizationId}`,
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
    await adminDb.delete(lots).where(eq(lots.organizationId, organizationId));
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

  it('receives a real lot with remainingQuantity starting equal to initialQuantity', async () => {
    const repo = new LotRepository(createScopedDb(client), organizationId);
    const id = generateId();
    const created = await repo.receive({
      id,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '25000.000000',
      unitCost: '0.0012',
      currency: 'USD',
    });

    expect(created.id).toBe(id);
    expect(created.remainingQuantity).toBe('25000.000000');
    expect(created.initialQuantity).toBe('25000.000000');
    expect(created.status).toBe('ACTIVE');
  });

  it('rejects a lot whose remainingQuantity would exceed initialQuantity (database CHECK, not just application code)', async () => {
    const adminDb = drizzle(adminClient, { schema });
    await expect(
      adminDb.insert(lots).values({
        id: generateId(),
        organizationId,
        storeId,
        productId,
        variantId,
        receivedAt: new Date(),
        initialQuantity: '10.000000',
        remainingQuantity: '15.000000',
        unitCost: '0.01',
        currency: 'USD',
      })
    ).rejects.toThrow(/lots_remaining_within_initial/);
  });

  it('findFefoCandidates orders by expiry date ascending, nulls last, then receivedAt', async () => {
    const repo = new LotRepository(createScopedDb(client), organizationId);
    const noExpiryId = generateId();
    const laterExpiryId = generateId();
    const earlierExpiryId = generateId();

    await repo.receive({
      id: noExpiryId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date('2026-08-01T00:00:00Z'),
      initialQuantity: '10.000000',
      unitCost: '0.01',
      currency: 'USD',
    });
    await repo.receive({
      id: laterExpiryId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date('2026-08-02T00:00:00Z'),
      expiryDate: '2026-09-01',
      initialQuantity: '10.000000',
      unitCost: '0.01',
      currency: 'USD',
    });
    await repo.receive({
      id: earlierExpiryId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date('2026-08-03T00:00:00Z'),
      expiryDate: '2026-08-15',
      initialQuantity: '10.000000',
      unitCost: '0.01',
      currency: 'USD',
    });

    const result = await repo.findFefoCandidates(storeId, productId);
    expect(result.map((l) => l.id)).toEqual([earlierExpiryId, laterExpiryId, noExpiryId]);
  });

  it('findFefoCandidates excludes DEPLETED lots and lots with zero remaining quantity', async () => {
    const repo = new LotRepository(createScopedDb(client), organizationId);
    const activeId = generateId();
    const depletedId = generateId();

    await repo.receive({
      id: activeId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '10.000000',
      unitCost: '0.01',
      currency: 'USD',
    });
    await repo.receive({
      id: depletedId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '10.000000',
      unitCost: '0.01',
      currency: 'USD',
    });
    await repo.draw(depletedId, '10.000000');

    const result = await repo.findFefoCandidates(storeId, productId);
    expect(result.map((l) => l.id)).toEqual([activeId]);
  });

  it('draw reduces remainingQuantity and auto-transitions to DEPLETED when it reaches zero', async () => {
    const repo = new LotRepository(createScopedDb(client), organizationId);
    const id = generateId();
    await repo.receive({
      id,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '10.000000',
      unitCost: '0.01',
      currency: 'USD',
    });

    const afterPartialDraw = await repo.draw(id, '4.000000');
    expect(afterPartialDraw.remainingQuantity).toBe('6.000000');
    expect(afterPartialDraw.status).toBe('ACTIVE');

    const afterFullDraw = await repo.draw(id, '6.000000');
    expect(afterFullDraw.remainingQuantity).toBe('0.000000');
    expect(afterFullDraw.status).toBe('DEPLETED');
  });

  it('draw rejects drawing from an already-DEPLETED lot', async () => {
    const repo = new LotRepository(createScopedDb(client), organizationId);
    const id = generateId();
    await repo.receive({
      id,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '5.000000',
      unitCost: '0.01',
      currency: 'USD',
    });
    await repo.draw(id, '5.000000');

    await expect(repo.draw(id, '1.000000')).rejects.toThrow(/not found, not ACTIVE/);
  });

  it('draw rejects drawing more than remaining (database CHECK, not just application code)', async () => {
    const repo = new LotRepository(createScopedDb(client), organizationId);
    const id = generateId();
    await repo.receive({
      id,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '5.000000',
      unitCost: '0.01',
      currency: 'USD',
    });

    await expect(repo.draw(id, '10.000000')).rejects.toThrow(/lots_remaining_within_initial/);
  });

  it('findById returns null for a lot that does not exist', async () => {
    const repo = new LotRepository(createScopedDb(client), organizationId);
    const result = await repo.findById(generateId());
    expect(result).toBeNull();
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new LotRepository(db, '')).toThrow(/organizationId/);
  });
});
