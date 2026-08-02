import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { organizations, storageLocations, stores } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { StorageLocationRepository } from './storage-location-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('StorageLocationRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let otherStoreId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Storage Location Test Org',
      slug: `storage-location-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({
      id: storeId,
      organizationId,
      name: 'Main Store',
      timezone: 'America/New_York',
    });

    otherStoreId = generateId();
    await adminDb.insert(stores).values({
      id: otherStoreId,
      organizationId,
      name: 'Second Store',
      timezone: 'America/New_York',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(storageLocations).where(eq(storageLocations.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('creates a storage location scoped to a store in the same organization', async () => {
    const repo = new StorageLocationRepository(createScopedDb(client), organizationId);
    const id = generateId();
    const created = await repo.create({ id, storeId, name: 'Walk-in Fridge' });

    expect(created.storeId).toBe(storeId);
    expect(created.name).toBe('Walk-in Fridge');
  });

  it('rejects creating a storage location for a store that does not exist', async () => {
    const repo = new StorageLocationRepository(createScopedDb(client), organizationId);
    await expect(
      repo.create({ id: generateId(), storeId: generateId(), name: 'Ghost Location' })
    ).rejects.toThrow(/not found/);
  });

  it('findByStore returns only locations for that store, not other stores in the same org', async () => {
    const repo = new StorageLocationRepository(createScopedDb(client), organizationId);
    const mainId = generateId();
    const otherId = generateId();
    await repo.create({ id: mainId, storeId, name: 'Dry Storage' });
    await repo.create({ id: otherId, storeId: otherStoreId, name: 'Dry Storage' });

    const result = await repo.findByStore(storeId);

    expect(result.map((l) => l.id)).toEqual([mainId]);
  });

  it('the same location name can be reused across two different stores in the same org', async () => {
    const repo = new StorageLocationRepository(createScopedDb(client), organizationId);

    await expect(repo.create({ id: generateId(), storeId, name: 'Walk-in' })).resolves.toBeDefined();
    await expect(
      repo.create({ id: generateId(), storeId: otherStoreId, name: 'Walk-in' })
    ).resolves.toBeDefined();
  });

  it('rejects a duplicate location name within the same store', async () => {
    const repo = new StorageLocationRepository(createScopedDb(client), organizationId);
    await repo.create({ id: generateId(), storeId, name: 'Bar Well' });

    await expect(repo.create({ id: generateId(), storeId, name: 'Bar Well' })).rejects.toThrow();
  });

  it('findAll excludes soft-deleted storage locations', async () => {
    const repo = new StorageLocationRepository(createScopedDb(client), organizationId);
    const id = generateId();
    await repo.create({ id, storeId, name: 'Freezer' });

    const adminDb = drizzle(adminClient, { schema });
    await adminDb.update(storageLocations).set({ deletedAt: new Date() }).where(eq(storageLocations.id, id));

    const all = await repo.findAll();
    expect(all.some((l) => l.id === id)).toBe(false);
  });
});
