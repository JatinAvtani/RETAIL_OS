import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { organizations, productVariants, products } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { ProductRepository } from './product-repository';
import { UnitRepository } from './unit-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('ProductRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let kgId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Product Test Org',
      slug: `product-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    const unitRepo = new UnitRepository(drizzle(client, { schema }));
    kgId = (await unitRepo.findByCode('kg'))!.id;
  });

  afterEach(async () => {
    // product_variants has no organization_id of its own (see schema comment) — clean it up via
    // its parent products, then the products themselves.
    const adminDb = drizzle(adminClient, { schema });
    const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
    for (const p of orgProducts) {
      await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
    }
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('create always creates exactly one default variant alongside the product', async () => {
    const repo = new ProductRepository(createScopedDb(client), organizationId);
    const id = generateId();
    const product = await repo.create({ id, sku: 'FLOUR-01', name: 'Flour', baseUnitId: kgId, type: 'INGREDIENT' });

    const variants = await repo.findVariants(product.id);
    expect(variants).toHaveLength(1);
    const [defaultVariant] = variants;
    expect(defaultVariant?.isDefault).toBe(true);
    expect(defaultVariant?.name).toBe('Flour');
  });

  it('addVariant creates a non-default variant, leaving the default variant unique', async () => {
    const repo = new ProductRepository(createScopedDb(client), organizationId);
    const id = generateId();
    const product = await repo.create({ id, sku: 'SHIRT-01', name: 'T-Shirt', baseUnitId: kgId, type: 'SELLABLE' });
    await repo.addVariant(product.id, { name: 'T-Shirt — Large', sku: 'SHIRT-01-L' });

    const variants = await repo.findVariants(product.id);
    expect(variants).toHaveLength(2);
    expect(variants.filter((v) => v.isDefault)).toHaveLength(1);
  });

  it('rejects a duplicate SKU within the same organization', async () => {
    const repo = new ProductRepository(createScopedDb(client), organizationId);
    await repo.create({ id: generateId(), sku: 'DUP-01', name: 'First', baseUnitId: kgId, type: 'INGREDIENT' });

    await expect(
      repo.create({ id: generateId(), sku: 'DUP-01', name: 'Second', baseUnitId: kgId, type: 'INGREDIENT' })
    ).rejects.toThrow();
  });

  it('allows SKU reuse after the original product is soft-deleted', async () => {
    const repo = new ProductRepository(createScopedDb(client), organizationId);
    const firstId = generateId();
    await repo.create({ id: firstId, sku: 'REUSE-01', name: 'First', baseUnitId: kgId, type: 'INGREDIENT' });

    const adminDb = drizzle(adminClient, { schema });
    await adminDb.update(products).set({ deletedAt: new Date() }).where(eq(products.id, firstId));

    await expect(
      repo.create({ id: generateId(), sku: 'REUSE-01', name: 'Second', baseUnitId: kgId, type: 'INGREDIENT' })
    ).resolves.toBeDefined();
  });

  it('addVariant rejects when the product does not exist in this organization', async () => {
    const repo = new ProductRepository(createScopedDb(client), organizationId);
    await expect(repo.addVariant(generateId(), { name: 'Ghost variant' })).rejects.toThrow(/not found/);
  });

  it('findAll excludes soft-deleted products', async () => {
    const repo = new ProductRepository(createScopedDb(client), organizationId);
    const id = generateId();
    await repo.create({ id, sku: 'HIDDEN-01', name: 'Hidden', baseUnitId: kgId, type: 'INGREDIENT' });

    const adminDb = drizzle(adminClient, { schema });
    await adminDb.update(products).set({ deletedAt: new Date() }).where(eq(products.id, id));

    const all = await repo.findAll();
    expect(all.some((p) => p.id === id)).toBe(false);
  });
});
