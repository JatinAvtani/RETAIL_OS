import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { suppliers } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SupplierRepository } from './supplier-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SupplierRepository cross-tenant isolation', () => {
  let fixture: TwoTenantFixture;
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;

  beforeAll(async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, fixture.tenantB.organizationId));
  });

  afterAll(async () => {
    await client.end();
    await adminClient.end();
    await fixture.cleanup();
  });

  it("never returns tenant B's supplier when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoB = new SupplierRepository(db, fixture.tenantB.organizationId);
    const supplier = await repoB.create({ id: generateId(), name: 'Tenant B Supplier' });

    const repoA = new SupplierRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findById(supplier.id);

    expect(result).toBeNull();
  });

  it("findAll scoped to tenant A never includes tenant B's suppliers", async () => {
    const db = createScopedDb(client);
    const repoA = new SupplierRepository(db, fixture.tenantA.organizationId);
    const repoB = new SupplierRepository(db, fixture.tenantB.organizationId);
    const own = await repoA.create({ id: generateId(), name: 'Tenant A Supplier' });
    const other = await repoB.create({ id: generateId(), name: 'Tenant B Supplier' });

    const result = await repoA.findAll();

    expect(result.some((s) => s.id === other.id)).toBe(false);
    expect(result.some((s) => s.id === own.id)).toBe(true);
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new SupplierRepository(db, '')).toThrow(/organizationId/);
  });
});
