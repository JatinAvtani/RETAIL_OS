import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import {
  organizations,
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
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SupplierPriceRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let supplierProductId: string;
  let supplierId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Supplier Price Test Org',
      slug: `sprice-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    const db = createScopedDb(client);
    const supplierRepo = new SupplierRepository(db, organizationId);
    const supplier = await supplierRepo.create({ id: generateId(), name: 'Price Test Supplier' });
    supplierId = supplier.id;

    const unitRepo = new UnitRepository(drizzle(client, { schema }));
    const kgId = (await unitRepo.findByCode('kg'))!.id;
    const productRepo = new ProductRepository(db, organizationId);
    const product = await productRepo.create({
      id: generateId(),
      sku: 'FLOUR-PRICE',
      name: 'Flour',
      baseUnitId: kgId,
      type: 'INGREDIENT',
    });

    const supplierProductRepo = new SupplierProductRepository(db, organizationId);
    const mapping = await supplierProductRepo.create({
      id: generateId(),
      supplierId: supplier.id,
      productId: product.id,
      supplierSku: 'FLR-PRICE-TEST',
    });
    supplierProductId = mapping.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, supplierProductId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    const mapping = (
      await adminDb.select().from(supplierProducts).where(eq(supplierProducts.id, supplierProductId))
    )[0];
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.id, supplierProductId));
    if (mapping) {
      await adminDb.delete(productVariants).where(eq(productVariants.productId, mapping.productId));
      await adminDb.delete(products).where(eq(products.id, mapping.productId));
      await adminDb.delete(suppliers).where(eq(suppliers.id, mapping.supplierId));
    }
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('recordNewPrice creates an open-ended current price when none exists', async () => {
    const repo = new SupplierPriceRepository(createScopedDb(client), organizationId);
    const price = await repo.recordNewPrice({
      id: generateId(),
      supplierProductId,
      unitPrice: '10.0000',
      currency: 'USD',
      validFrom: new Date('2026-01-01T00:00:00Z'),
    });

    expect(price.validTo).toBeNull();
    const current = await repo.findCurrent(supplierProductId);
    expect(current?.id).toBe(price.id);
  });

  it('recordNewPrice closes the previous open-ended row when a new price is recorded', async () => {
    const repo = new SupplierPriceRepository(createScopedDb(client), organizationId);
    const first = await repo.recordNewPrice({
      id: generateId(),
      supplierProductId,
      unitPrice: '10.0000',
      currency: 'USD',
      validFrom: new Date('2026-01-01T00:00:00Z'),
    });
    const second = await repo.recordNewPrice({
      id: generateId(),
      supplierProductId,
      unitPrice: '12.0000',
      currency: 'USD',
      validFrom: new Date('2026-02-01T00:00:00Z'),
    });

    const history = await repo.findHistory(supplierProductId);
    const closedFirst = history.find((h) => h.id === first.id);
    expect(closedFirst?.validTo?.toISOString()).toBe('2026-02-01T00:00:00.000Z');

    const current = await repo.findCurrent(supplierProductId);
    expect(current?.id).toBe(second.id);
  });

  it('findHistory returns rows newest-first', async () => {
    const repo = new SupplierPriceRepository(createScopedDb(client), organizationId);
    await repo.recordNewPrice({
      id: generateId(),
      supplierProductId,
      unitPrice: '10.0000',
      currency: 'USD',
      validFrom: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.recordNewPrice({
      id: generateId(),
      supplierProductId,
      unitPrice: '12.0000',
      currency: 'USD',
      validFrom: new Date('2026-02-01T00:00:00Z'),
    });

    const history = await repo.findHistory(supplierProductId);
    expect(history[0]?.unitPrice).toBe('12.0000');
    expect(history[1]?.unitPrice).toBe('10.0000');
  });

  it('the database rejects an overlapping price row even if the repository is bypassed', async () => {
    // Direct insert, not through recordNewPrice, proving the exclusion constraint is a real
    // database-level backstop and not something only the repository's logic prevents.
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.insert(supplierPrices).values({
      id: generateId(),
      supplierProductId,
      unitPrice: '10.0000',
      currency: 'USD',
      validFrom: new Date('2026-01-01T00:00:00Z'),
    });

    await expect(
      adminDb.insert(supplierPrices).values({
        id: generateId(),
        supplierProductId,
        unitPrice: '99.0000',
        currency: 'USD',
        validFrom: new Date('2026-01-15T00:00:00Z'),
      })
    ).rejects.toThrow(/exclusion constraint/);
  });

  it('findConfirmedTrailingPricesBySupplierSku returns confirmed prices, newest first', async () => {
    const supplierProductRepo = new SupplierProductRepository(createScopedDb(client), organizationId);
    await supplierProductRepo.confirm(supplierProductId);

    const repo = new SupplierPriceRepository(createScopedDb(client), organizationId);
    await repo.recordNewPrice({ id: generateId(), supplierProductId, unitPrice: '10.0000', currency: 'USD', validFrom: new Date('2026-01-01T00:00:00Z') });
    await repo.recordNewPrice({ id: generateId(), supplierProductId, unitPrice: '12.0000', currency: 'USD', validFrom: new Date('2026-02-01T00:00:00Z') });

    const trailing = await repo.findConfirmedTrailingPricesBySupplierSku(supplierId, 'FLR-PRICE-TEST');
    expect(trailing).toHaveLength(2);
    expect(trailing[0]?.unitPrice).toBe('12.0000');
    expect(trailing[1]?.unitPrice).toBe('10.0000');
  });

  it('findConfirmedTrailingPricesBySupplierSku, given a currency, excludes trailing prices recorded in a different currency', async () => {
    const supplierProductRepo = new SupplierProductRepository(createScopedDb(client), organizationId);
    await supplierProductRepo.confirm(supplierProductId);

    const repo = new SupplierPriceRepository(createScopedDb(client), organizationId);
    await repo.recordNewPrice({ id: generateId(), supplierProductId, unitPrice: '10.0000', currency: 'USD', validFrom: new Date('2026-01-01T00:00:00Z') });

    // A USD trailing price must never feed a check against a newly extracted INR price — the
    // magnitudes aren't comparable at all, currency filtering isn't optional once a currency is known.
    const trailingInr = await repo.findConfirmedTrailingPricesBySupplierSku(supplierId, 'FLR-PRICE-TEST', 'INR');
    expect(trailingInr).toHaveLength(0);

    const trailingUsd = await repo.findConfirmedTrailingPricesBySupplierSku(supplierId, 'FLR-PRICE-TEST', 'USD');
    expect(trailingUsd).toHaveLength(1);

    // Omitting currency entirely (a caller that hasn't resolved one yet) is unfiltered — the old behavior.
    const trailingUnfiltered = await repo.findConfirmedTrailingPricesBySupplierSku(supplierId, 'FLR-PRICE-TEST');
    expect(trailingUnfiltered).toHaveLength(1);
  });

  it('findConfirmedTrailingPricesBySupplierSku matches the SKU case-insensitively', async () => {
    const supplierProductRepo = new SupplierProductRepository(createScopedDb(client), organizationId);
    await supplierProductRepo.confirm(supplierProductId);

    const repo = new SupplierPriceRepository(createScopedDb(client), organizationId);
    await repo.recordNewPrice({ id: generateId(), supplierProductId, unitPrice: '10.0000', currency: 'USD', validFrom: new Date('2026-01-01T00:00:00Z') });

    const trailing = await repo.findConfirmedTrailingPricesBySupplierSku(supplierId, 'flr-price-test');
    expect(trailing).toHaveLength(1);
  });

  it('findConfirmedTrailingPricesBySupplierSku returns nothing for an UNCONFIRMED mapping — an unconfirmed row must never feed a validation gate', async () => {
    // A dedicated, never-confirmed mapping — `supplierProductId` (the shared fixture) may already
    // be confirmed by an earlier test in this file, since confirm() is permanent (no unconfirm()).
    const db = createScopedDb(client);
    const unitRepo = new UnitRepository(drizzle(client, { schema }));
    const kgId = (await unitRepo.findByCode('kg'))!.id;
    const productRepo = new ProductRepository(db, organizationId);
    const unconfirmedProduct = await productRepo.create({ id: generateId(), sku: 'FLOUR-UNCONFIRMED', name: 'Flour (unconfirmed)', baseUnitId: kgId, type: 'INGREDIENT' });
    const supplierProductRepo = new SupplierProductRepository(db, organizationId);
    const unconfirmedMapping = await supplierProductRepo.create({ id: generateId(), supplierId, productId: unconfirmedProduct.id, supplierSku: 'FLR-UNCONFIRMED-SKU' });

    const repo = new SupplierPriceRepository(db, organizationId);
    await repo.recordNewPrice({ id: generateId(), supplierProductId: unconfirmedMapping.id, unitPrice: '10.0000', currency: 'USD', validFrom: new Date('2026-01-01T00:00:00Z') });

    const trailing = await repo.findConfirmedTrailingPricesBySupplierSku(supplierId, 'FLR-UNCONFIRMED-SKU');
    expect(trailing).toHaveLength(0);

    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, unconfirmedMapping.id));
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.id, unconfirmedMapping.id));
    await adminDb.delete(productVariants).where(eq(productVariants.productId, unconfirmedProduct.id));
    await adminDb.delete(products).where(eq(products.id, unconfirmedProduct.id));
  });

  it('findConfirmedTrailingPricesBySupplierSku returns nothing for a SKU with no mapping at all', async () => {
    const repo = new SupplierPriceRepository(createScopedDb(client), organizationId);
    const trailing = await repo.findConfirmedTrailingPricesBySupplierSku(supplierId, 'NONEXISTENT-SKU');
    expect(trailing).toHaveLength(0);
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new SupplierPriceRepository(db, '')).toThrow(/organizationId/);
  });
});
