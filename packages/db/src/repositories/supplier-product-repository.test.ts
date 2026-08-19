import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { organizations, products, productVariants, supplierProducts, suppliers } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SupplierProductRepository } from './supplier-product-repository';
import { SupplierRepository } from './supplier-repository';
import { ProductRepository } from './product-repository';
import { UnitRepository } from './unit-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SupplierProductRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let supplierId: string;
  let productId: string;
  let kgId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Supplier Product Test Org',
      slug: `sp-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    const db = createScopedDb(client);
    const supplierRepo = new SupplierRepository(db, organizationId);
    const supplier = await supplierRepo.create({ id: generateId(), name: 'Test Supplier' });
    supplierId = supplier.id;

    const unitRepo = new UnitRepository(drizzle(client, { schema }));
    kgId = (await unitRepo.findByCode('kg'))!.id;

    const productRepo = new ProductRepository(db, organizationId);
    const product = await productRepo.create({
      id: generateId(),
      sku: 'FLOUR-SP',
      name: 'Flour',
      baseUnitId: kgId,
      type: 'INGREDIENT',
    });
    productId = product.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(productVariants).where(eq(productVariants.productId, productId));
    await adminDb.delete(products).where(eq(products.id, productId));
    await adminDb.delete(suppliers).where(eq(suppliers.id, supplierId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('create always inserts as unconfirmed, never pre-confirmed', async () => {
    const repo = new SupplierProductRepository(createScopedDb(client), organizationId);
    const mapping = await repo.create({
      id: generateId(),
      supplierId,
      productId,
      supplierSku: 'FLR-00123',
      packSize: '25',
      conversionToBase: '25',
    });

    expect(mapping.isConfirmed).toBe(false);
  });

  it('findConfirmedForProduct excludes unconfirmed mappings', async () => {
    const repo = new SupplierProductRepository(createScopedDb(client), organizationId);
    const mapping = await repo.create({ id: generateId(), supplierId, productId, supplierSku: 'FLR-UNCONFIRMED' });

    const confirmed = await repo.findConfirmedForProduct(productId);

    expect(confirmed.some((m) => m.id === mapping.id)).toBe(false);
  });

  it('confirm makes a mapping visible to findConfirmedForProduct', async () => {
    const repo = new SupplierProductRepository(createScopedDb(client), organizationId);
    const mapping = await repo.create({ id: generateId(), supplierId, productId, supplierSku: 'FLR-CONFIRM-ME' });

    await repo.confirm(mapping.id);
    const confirmed = await repo.findConfirmedForProduct(productId);

    expect(confirmed.some((m) => m.id === mapping.id)).toBe(true);
  });

  it('findConfirmedBySupplier returns only confirmed mappings for that supplier', async () => {
    const repo = new SupplierProductRepository(createScopedDb(client), organizationId);
    const confirmedMapping = await repo.create({ id: generateId(), supplierId, productId, supplierSku: 'FLR-BY-SUPPLIER-CONFIRMED' });
    await repo.confirm(confirmedMapping.id);
    const unconfirmedMapping = await repo.create({ id: generateId(), supplierId, productId, supplierSku: 'FLR-BY-SUPPLIER-UNCONFIRMED' });

    const results = await repo.findConfirmedBySupplier(supplierId);

    expect(results.some((m) => m.id === confirmedMapping.id)).toBe(true);
    expect(results.some((m) => m.id === unconfirmedMapping.id)).toBe(false);
  });

  it('rejects a duplicate supplier SKU for the same supplier in the same org', async () => {
    const repo = new SupplierProductRepository(createScopedDb(client), organizationId);
    await repo.create({ id: generateId(), supplierId, productId, supplierSku: 'DUP-SKU' });

    await expect(
      repo.create({ id: generateId(), supplierId, productId, supplierSku: 'DUP-SKU' })
    ).rejects.toThrow();
  });

  it('findBySupplierAndSku finds an existing mapping (confirmed or not) for the exact pair, ', async () => {
    const repo = new SupplierProductRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ id: generateId(), supplierId, productId, supplierSku: 'FIND-ME' });

    const found = await repo.findBySupplierAndSku(supplierId, 'FIND-ME');
    expect(found?.id).toBe(created.id);
    expect(found?.isConfirmed).toBe(false);
  });

  it('findBySupplierAndSku returns null when no mapping exists for that pair', async () => {
    const repo = new SupplierProductRepository(createScopedDb(client), organizationId);
    const found = await repo.findBySupplierAndSku(supplierId, 'NEVER-CREATED');
    expect(found).toBeNull();
  });
});
