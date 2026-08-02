import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { organizations, productVariants, products, unitConversions } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { UnitConversionRepository } from './unit-conversion-repository';
import { UnitRepository } from './unit-repository';
import { ProductRepository } from './product-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('UnitConversionRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let kgId: string;
  let gId: string;
  let caseId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Conversion Test Org',
      slug: `conversion-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    const unitRepo = new UnitRepository(drizzle(client, { schema }));
    kgId = (await unitRepo.findByCode('kg'))!.id;
    gId = (await unitRepo.findByCode('g'))!.id;
    // 'each' stands in for a packaging unit like "case" here — 'case' itself isn't a real global
    // unit (correctly: a case's contents are product-specific, which is exactly what this test
    // exercises), but from_unit_id/to_unit_id both have real FKs to units.id, so the test needs
    // an actual seeded unit on both sides even when the conversion itself is product-only.
    caseId = (await unitRepo.findByCode('each'))!.id;
  });

  /** unit_conversions.product_id has a real FK to products.id (added once products existed) —
   * every productId a test uses must be a real row, not an arbitrary UUID. */
  const createTestProduct = async () => {
    const productRepo = new ProductRepository(createScopedDb(client), organizationId);
    const product = await productRepo.create({
      id: generateId(),
      sku: `TEST-${generateId()}`,
      name: 'Test Product',
      baseUnitId: kgId,
      type: 'INGREDIENT',
    });
    return product.id;
  };

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    // unit_conversions first (its product_id FK points at products), then product_variants (its
    // product_id FK points at products), then products itself — FK-dependency order.
    await adminDb.delete(unitConversions).where(eq(unitConversions.organizationId, organizationId));
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

  it('findFactor returns null when no conversion exists', async () => {
    const repo = new UnitConversionRepository(createScopedDb(client), organizationId);
    const result = await repo.findFactor(kgId, gId);
    expect(result).toBeNull();
  });

  it('findFactor returns the global row when only a global conversion exists', async () => {
    const repo = new UnitConversionRepository(createScopedDb(client), organizationId);
    await repo.create({ id: generateId(), fromUnitId: kgId, toUnitId: gId, factor: '1000' });

    const result = await repo.findFactor(kgId, gId);
    expect(result?.factor).toBe('1000.000000000');
    expect(result?.productId).toBeNull();
  });

  it('findFactor prefers the product-specific row over the global row for the same pair', async () => {
    const repo = new UnitConversionRepository(createScopedDb(client), organizationId);
    const productId = await createTestProduct();
    // Global: 1 kg = 1000 g. Product-specific override for this one product: 1 kg (of it) = 900 g
    // net after some deliberate packaging loss — a contrived but valid example of why per-product
    // rows must win when both exist.
    await repo.create({ id: generateId(), fromUnitId: kgId, toUnitId: gId, factor: '1000' });
    await repo.create({
      id: generateId(),
      fromUnitId: kgId,
      toUnitId: gId,
      factor: '900',
      productId,
    });

    const withProduct = await repo.findFactor(kgId, gId, productId);
    const withoutProduct = await repo.findFactor(kgId, gId);

    expect(withProduct?.factor).toBe('900.000000000');
    expect(withProduct?.productId).toBe(productId);
    expect(withoutProduct?.factor).toBe('1000.000000000');
  });

  it('findFactor falls back to global when a product-specific row exists for a different product', async () => {
    const repo = new UnitConversionRepository(createScopedDb(client), organizationId);
    const otherProductId = await createTestProduct();
    const queriedProductId = await createTestProduct();
    await repo.create({ id: generateId(), fromUnitId: kgId, toUnitId: gId, factor: '1000' });
    await repo.create({
      id: generateId(),
      fromUnitId: kgId,
      toUnitId: gId,
      factor: '25000',
      productId: otherProductId,
    });

    const result = await repo.findFactor(kgId, gId, queriedProductId);
    expect(result?.factor).toBe('1000.000000000');
  });

  it('findFactor is null for a product-only conversion (e.g. case sizing) with no global fallback', async () => {
    const repo = new UnitConversionRepository(createScopedDb(client), organizationId);
    const productId = await createTestProduct();
    const anotherProductId = await createTestProduct();
    await repo.create({
      id: generateId(),
      fromUnitId: caseId,
      toUnitId: kgId,
      factor: '25',
      productId,
    });

    const forThatProduct = await repo.findFactor(caseId, kgId, productId);
    const forAnotherProduct = await repo.findFactor(caseId, kgId, anotherProductId);

    expect(forThatProduct?.factor).toBe('25.000000000');
    expect(forAnotherProduct).toBeNull();
  });

  it('rejects a duplicate global conversion for the same unit pair (partial unique index)', async () => {
    const repo = new UnitConversionRepository(createScopedDb(client), organizationId);
    await repo.create({ id: generateId(), fromUnitId: kgId, toUnitId: gId, factor: '1000' });

    await expect(
      repo.create({ id: generateId(), fromUnitId: kgId, toUnitId: gId, factor: '999' })
    ).rejects.toThrow();
  });

  it('rejects a duplicate product-specific conversion for the same unit pair and product', async () => {
    const repo = new UnitConversionRepository(createScopedDb(client), organizationId);
    const productId = await createTestProduct();
    await repo.create({ id: generateId(), fromUnitId: caseId, toUnitId: kgId, factor: '25', productId });

    await expect(
      repo.create({ id: generateId(), fromUnitId: caseId, toUnitId: kgId, factor: '30', productId })
    ).rejects.toThrow();
  });
});
