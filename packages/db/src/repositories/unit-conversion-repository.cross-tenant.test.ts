import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { productVariants, products, unitConversions } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { UnitConversionRepository } from './unit-conversion-repository';
import { UnitRepository } from './unit-repository';
import { ProductRepository } from './product-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

/**
 * Same shape as store-repository.cross-tenant.test.ts: connects as retailos_app (not postgres),
 * proves the application-layer repository never leaks a tenant-B row into a tenant-A-scoped
 * query, real Postgres, no mocking of RLS.
 */
const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('UnitConversionRepository cross-tenant isolation', () => {
  let fixture: TwoTenantFixture;
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let kgId: string;
  let gId: string;

  beforeAll(async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const unitRepo = new UnitRepository(drizzle(client, { schema }));
    kgId = (await unitRepo.findByCode('kg'))!.id;
    gId = (await unitRepo.findByCode('g'))!.id;
  });

  afterEach(async () => {
    // Deletes as postgres (bypasses RLS), same reasoning as tenant-fixture.ts's own cleanup:
    // clearing rows across both tenants in one call is exactly what the app-scoped role can't do.
    // FK-dependency order: unit_conversions, then product_variants, then products.
    const adminDb = drizzle(adminClient, { schema });
    for (const org of [fixture.tenantA.organizationId, fixture.tenantB.organizationId]) {
      await adminDb.delete(unitConversions).where(eq(unitConversions.organizationId, org));
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

  it("never returns tenant B's product-specific conversion when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const productRepoB = new ProductRepository(db, fixture.tenantB.organizationId);
    const product = await productRepoB.create({
      id: generateId(),
      sku: `TEST-${generateId()}`,
      name: 'Tenant B Test Product',
      baseUnitId: kgId,
      type: 'INGREDIENT',
    });
    const productId = product.id;

    const repoB = new UnitConversionRepository(db, fixture.tenantB.organizationId);
    await repoB.create({ id: generateId(), fromUnitId: kgId, toUnitId: gId, factor: '1000', productId });

    const repoA = new UnitConversionRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findFactor(kgId, gId, productId);

    expect(result).toBeNull();
  });

  it("never returns tenant B's global conversion when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoB = new UnitConversionRepository(db, fixture.tenantB.organizationId);
    await repoB.create({ id: generateId(), fromUnitId: kgId, toUnitId: gId, factor: '1000' });

    const repoA = new UnitConversionRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findFactor(kgId, gId);

    expect(result).toBeNull();
  });

  it('symmetrically denies tenant A conversions when scoped to tenant B', async () => {
    const db = createScopedDb(client);
    const repoA = new UnitConversionRepository(db, fixture.tenantA.organizationId);
    await repoA.create({ id: generateId(), fromUnitId: kgId, toUnitId: gId, factor: '1000' });

    const repoB = new UnitConversionRepository(db, fixture.tenantB.organizationId);
    const result = await repoB.findFactor(kgId, gId);

    expect(result).toBeNull();
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new UnitConversionRepository(db, '')).toThrow(/organizationId/);
  });
});
