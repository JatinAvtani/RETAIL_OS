import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import {
  productVariants,
  products,
  supplierPrices,
  supplierProducts,
  suppliers,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SupplierPriceRepository } from './supplier-price-repository';
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

describe('SupplierPriceRepository cross-tenant isolation', () => {
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
      const orgSupplierProducts = await adminDb
        .select({ id: supplierProducts.id })
        .from(supplierProducts)
        .where(eq(supplierProducts.organizationId, org));
      for (const sp of orgSupplierProducts) {
        await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, sp.id));
      }
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

  it("never returns tenant B's price history when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const supplierRepoB = new SupplierRepository(db, fixture.tenantB.organizationId);
    const productRepoB = new ProductRepository(db, fixture.tenantB.organizationId);
    const supplierB = await supplierRepoB.create({ id: generateId(), name: 'Tenant B Supplier' });
    const productB = await productRepoB.create({
      id: generateId(),
      sku: 'B-SKU-PRICE',
      name: 'Tenant B Product',
      baseUnitId: kgId,
      type: 'INGREDIENT',
    });
    const supplierProductRepoB = new SupplierProductRepository(db, fixture.tenantB.organizationId);
    const mappingB = await supplierProductRepoB.create({
      id: generateId(),
      supplierId: supplierB.id,
      productId: productB.id,
      supplierSku: 'B-PRICE-SKU',
    });

    const priceRepoB = new SupplierPriceRepository(db, fixture.tenantB.organizationId);
    await priceRepoB.recordNewPrice({
      id: generateId(),
      supplierProductId: mappingB.id,
      unitPrice: '10.0000',
      currency: 'USD',
      validFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const priceRepoA = new SupplierPriceRepository(db, fixture.tenantA.organizationId);
    const result = await priceRepoA.findHistory(mappingB.id);

    expect(result).toEqual([]);
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new SupplierPriceRepository(db, '')).toThrow(/organizationId/);
  });
});
