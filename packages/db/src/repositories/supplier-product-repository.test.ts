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

  it('findAllConfirmedWithLabels returns a real "Product (Supplier)" label, confirmed mappings only, org-wide', async () => {
    const repo = new SupplierProductRepository(createScopedDb(client), organizationId);
    const confirmedMapping = await repo.create({ id: generateId(), supplierId, productId, supplierSku: 'FLR-LABEL-CONFIRMED' });
    await repo.confirm(confirmedMapping.id);
    const unconfirmedMapping = await repo.create({ id: generateId(), supplierId, productId, supplierSku: 'FLR-LABEL-UNCONFIRMED' });

    const candidates = await repo.findAllConfirmedWithLabels();

    const confirmedCandidate = candidates.find((c) => c.candidateId === confirmedMapping.id);
    expect(confirmedCandidate).toBeDefined();
    expect(confirmedCandidate!.label).toBe('Flour (Test Supplier)');
    expect(candidates.some((c) => c.candidateId === unconfirmedMapping.id)).toBe(false);
  });

  it('findAllConfirmedWithLabels excludes a mapping whose product has since been soft-deleted', async () => {
    const db = createScopedDb(client);
    const productRepo = new ProductRepository(db, organizationId);
    const deletedProduct = await productRepo.create({ id: generateId(), sku: 'DELETED-SKU', name: 'Discontinued Item', baseUnitId: kgId, type: 'INGREDIENT' });

    const repo = new SupplierProductRepository(db, organizationId);
    const mapping = await repo.create({ id: generateId(), supplierId, productId: deletedProduct.id, supplierSku: 'FLR-DELETED-PRODUCT' });
    await repo.confirm(mapping.id);

    try {
      // No repository method soft-deletes a product today — writing `deletedAt` directly via the
      // admin connection is the same simulation technique this codebase's own tests already use
      // wherever a real mutation path doesn't exist yet.
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.update(products).set({ deletedAt: new Date() }).where(eq(products.id, deletedProduct.id));

      const candidates = await repo.findAllConfirmedWithLabels();
      expect(candidates.some((c) => c.candidateId === mapping.id)).toBe(false);
    } finally {
      // Child-before-parent: supplier_products references products, which the file-level
      // `afterEach` above hasn't cleaned up yet at this point in the test.
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(supplierProducts).where(eq(supplierProducts.id, mapping.id));
      await adminDb.delete(productVariants).where(eq(productVariants.productId, deletedProduct.id));
      await adminDb.delete(products).where(eq(products.id, deletedProduct.id));
    }
  });
});
