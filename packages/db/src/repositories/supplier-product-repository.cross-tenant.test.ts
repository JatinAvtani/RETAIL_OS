import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { productVariants, products, supplierProducts, suppliers } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SupplierProductRepository } from './supplier-product-repository';
import { SupplierRepository } from './supplier-repository';
import { ProductRepository } from './product-repository';
import { UnitRepository } from './unit-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SupplierProductRepository cross-tenant isolation', () => {
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
      await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, org));
      const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, org));
      for (const p of orgProducts) {
        await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await adminDb.delete(products).where(eq(products.organizationId, org));
      await adminDb.delete(suppliers).where(eq(suppliers.organizationId, org));
    }
  });

  afterAll(async () => {
    await client.end();
    await adminClient.end();
    await fixture.cleanup();
  });

  it("never returns tenant B's supplier-product mapping when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const supplierRepoB = new SupplierRepository(db, fixture.tenantB.organizationId);
    const productRepoB = new ProductRepository(db, fixture.tenantB.organizationId);
    const supplierB = await supplierRepoB.create({ id: generateId(), name: 'Tenant B Supplier' });
    const productB = await productRepoB.create({
      id: generateId(),
      sku: 'B-SKU-SP',
      name: 'Tenant B Product',
      baseUnitId: kgId,
      type: 'INGREDIENT',
    });

    const repoB = new SupplierProductRepository(db, fixture.tenantB.organizationId);
    const mapping = await repoB.create({
      id: generateId(),
      supplierId: supplierB.id,
      productId: productB.id,
      supplierSku: 'B-SUPPLIER-SKU',
    });

    const repoA = new SupplierProductRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findById(mapping.id);

    expect(result).toBeNull();
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new SupplierProductRepository(db, '')).toThrow(/organizationId/);
  });
});
