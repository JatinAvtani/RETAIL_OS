import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { storageLocations } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { StorageLocationRepository } from './storage-location-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('StorageLocationRepository cross-tenant isolation', () => {
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
    await adminDb.delete(storageLocations).where(eq(storageLocations.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(storageLocations).where(eq(storageLocations.organizationId, fixture.tenantB.organizationId));
  });

  afterAll(async () => {
    await client.end();
    await adminClient.end();
    await fixture.cleanup();
  });

  it("never returns tenant B's storage location when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoB = new StorageLocationRepository(db, fixture.tenantB.organizationId);
    const id = generateId();
    await repoB.create({ id, storeId: fixture.tenantB.storeId, name: 'Tenant B Walk-in' });

    const repoA = new StorageLocationRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findById(id);

    expect(result).toBeNull();
  });

  it("cannot create a storage location against tenant B's store while scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoA = new StorageLocationRepository(db, fixture.tenantA.organizationId);

    await expect(
      repoA.create({ id: generateId(), storeId: fixture.tenantB.storeId, name: 'Cross-Tenant Attempt' })
    ).rejects.toThrow(/not found/);
  });

  it("findByStore scoped to tenant A returns nothing for tenant B's store id", async () => {
    const db = createScopedDb(client);
    const repoB = new StorageLocationRepository(db, fixture.tenantB.organizationId);
    await repoB.create({ id: generateId(), storeId: fixture.tenantB.storeId, name: 'Tenant B Dry Storage' });

    const repoA = new StorageLocationRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findByStore(fixture.tenantB.storeId);

    expect(result).toEqual([]);
  });

  it("findAll scoped to tenant A never includes tenant B's storage locations", async () => {
    const db = createScopedDb(client);
    const repoA = new StorageLocationRepository(db, fixture.tenantA.organizationId);
    const repoB = new StorageLocationRepository(db, fixture.tenantB.organizationId);
    const ownId = generateId();
    const otherId = generateId();
    await repoA.create({ id: ownId, storeId: fixture.tenantA.storeId, name: 'Tenant A Freezer' });
    await repoB.create({ id: otherId, storeId: fixture.tenantB.storeId, name: 'Tenant B Freezer' });

    const result = await repoA.findAll();

    expect(result.some((l) => l.id === otherId)).toBe(false);
    expect(result.some((l) => l.id === ownId)).toBe(true);
  });

  it('the same location name is independently usable by two different tenants', async () => {
    const db = createScopedDb(client);
    const repoA = new StorageLocationRepository(db, fixture.tenantA.organizationId);
    const repoB = new StorageLocationRepository(db, fixture.tenantB.organizationId);

    await expect(
      repoA.create({ id: generateId(), storeId: fixture.tenantA.storeId, name: 'Walk-in' })
    ).resolves.toBeDefined();
    await expect(
      repoB.create({ id: generateId(), storeId: fixture.tenantB.storeId, name: 'Walk-in' })
    ).resolves.toBeDefined();
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new StorageLocationRepository(db, '')).toThrow(/organizationId/);
  });
});
