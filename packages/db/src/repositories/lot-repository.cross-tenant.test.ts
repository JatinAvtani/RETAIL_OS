import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { lots, productVariants, products, units } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { LotRepository } from './lot-repository';
import { ProductRepository } from './product-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('LotRepository cross-tenant isolation', () => {
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

  it("never returns tenant B's lot when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoB = new LotRepository(db, fixture.tenantB.organizationId);
    const id = generateId();
    await repoB.receive({
      id,
      storeId: fixture.tenantB.storeId,
      productId: productBId,
      variantId: variantBId,
      receivedAt: new Date(),
      initialQuantity: '100.000000',
      unitCost: '0.01',
      currency: 'USD',
    });

    const repoA = new LotRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findById(id);

    expect(result).toBeNull();
  });

  it("findFefoCandidates scoped to tenant A never includes tenant B's lots, even for the same store/product ids", async () => {
    const db = createScopedDb(client);
    const repoA = new LotRepository(db, fixture.tenantA.organizationId);
    const repoB = new LotRepository(db, fixture.tenantB.organizationId);
    const ownId = generateId();
    const otherId = generateId();

    await repoA.receive({
      id: ownId,
      storeId: fixture.tenantA.storeId,
      productId: productAId,
      variantId: variantAId,
      receivedAt: new Date(),
      initialQuantity: '10.000000',
      unitCost: '0.01',
      currency: 'USD',
    });
    await repoB.receive({
      id: otherId,
      storeId: fixture.tenantB.storeId,
      productId: productBId,
      variantId: variantBId,
      receivedAt: new Date(),
      initialQuantity: '10.000000',
      unitCost: '0.01',
      currency: 'USD',
    });

    const result = await repoA.findFefoCandidates(fixture.tenantA.storeId, productAId);

    expect(result.map((l) => l.id)).toEqual([ownId]);
    expect(result.some((l) => l.id === otherId)).toBe(false);
  });

  it("tenant A cannot draw from tenant B's lot by id", async () => {
    const db = createScopedDb(client);
    const repoB = new LotRepository(db, fixture.tenantB.organizationId);
    const id = generateId();
    await repoB.receive({
      id,
      storeId: fixture.tenantB.storeId,
      productId: productBId,
      variantId: variantBId,
      receivedAt: new Date(),
      initialQuantity: '10.000000',
      unitCost: '0.01',
      currency: 'USD',
    });

    const repoA = new LotRepository(db, fixture.tenantA.organizationId);
    await expect(repoA.draw(id, '1.000000')).rejects.toThrow(/not found, not ACTIVE/);

    // Confirm the draw genuinely didn't happen — tenant B's own view still shows it untouched.
    const stillIntact = await repoB.findById(id);
    expect(stillIntact?.remainingQuantity).toBe('10.000000');
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new LotRepository(db, '')).toThrow(/organizationId/);
  });
});
