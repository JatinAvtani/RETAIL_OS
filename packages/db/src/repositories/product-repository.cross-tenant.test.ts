import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { productVariants, products } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { ProductRepository } from './product-repository';
import { UnitRepository } from './unit-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('ProductRepository cross-tenant isolation', () => {
  let fixture: TwoTenantFixture;
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let kgId: string;

  beforeAll(async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const unitRepo = new UnitRepository(drizzle(client, { schema }));
    kgId = (await unitRepo.findByCode('kg'))!.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    for (const org of [fixture.tenantA.organizationId, fixture.tenantB.organizationId]) {
      const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, org));
      for (const p of orgProducts) {
        await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await adminDb.delete(products).where(eq(products.organizationId, org));
    }
  });

  afterAll(async () => {
    await client.end();
    await adminClient.end();
    await fixture.cleanup();
  });

  it("never returns tenant B's product when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoB = new ProductRepository(db, fixture.tenantB.organizationId);
    const id = generateId();
    await repoB.create({ id, sku: 'B-SKU', name: 'Tenant B Product', baseUnitId: kgId, type: 'INGREDIENT' });

    const repoA = new ProductRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findById(id);

    expect(result).toBeNull();
  });

  it("never returns tenant B's product variants when scoped to tenant A, even by product id", async () => {
    const db = createScopedDb(client);
    const repoB = new ProductRepository(db, fixture.tenantB.organizationId);
    const id = generateId();
    const product = await repoB.create({ id, sku: 'B-SKU-2', name: 'Tenant B Product', baseUnitId: kgId, type: 'INGREDIENT' });

    const repoA = new ProductRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findVariants(product.id);

    expect(result).toEqual([]);
  });

  it('the same SKU can be used independently by two different tenants', async () => {
    const db = createScopedDb(client);
    const repoA = new ProductRepository(db, fixture.tenantA.organizationId);
    const repoB = new ProductRepository(db, fixture.tenantB.organizationId);

    await expect(
      repoA.create({ id: generateId(), sku: 'SHARED-SKU', name: 'Tenant A Product', baseUnitId: kgId, type: 'INGREDIENT' })
    ).resolves.toBeDefined();
    await expect(
      repoB.create({ id: generateId(), sku: 'SHARED-SKU', name: 'Tenant B Product', baseUnitId: kgId, type: 'INGREDIENT' })
    ).resolves.toBeDefined();
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new ProductRepository(db, '')).toThrow(/organizationId/);
  });
});
