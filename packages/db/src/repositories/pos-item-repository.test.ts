import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { menuItems, organizations, posItems, stores } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { PosItemRepository } from './pos-item-repository';
import { MenuItemRepository } from './menu-item-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('PosItemRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Pos Item Test Org',
      slug: `pos-item-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({
      id: storeId,
      organizationId,
      name: 'Main Store',
      timezone: 'America/New_York',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(posItems).where(eq(posItems.organizationId, organizationId));
    await adminDb.delete(menuItems).where(eq(menuItems.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('upsert inserts a new catalog item as UNMAPPED', async () => {
    const repo = new PosItemRepository(createScopedDb(client), organizationId);
    const row = await repo.upsert({
      id: generateId(),
      storeId,
      source: 'square',
      externalId: 'SQ-CAT-1',
      name: 'Cappuccino',
      price: '4.50',
      currency: 'USD',
    });

    expect(row.mappingStatus).toBe('UNMAPPED');
    expect(row.name).toBe('Cappuccino');
    expect(row.menuItemId).toBeNull();
  });

  it('upsert on the same (store, source, external_id) updates in place, not a duplicate row', async () => {
    const repo = new PosItemRepository(createScopedDb(client), organizationId);
    const first = await repo.upsert({
      id: generateId(),
      storeId,
      source: 'square',
      externalId: 'SQ-CAT-2',
      name: 'Latte',
      price: '5.00',
    });
    const second = await repo.upsert({
      id: generateId(),
      storeId,
      source: 'square',
      externalId: 'SQ-CAT-2',
      name: 'Latte (Large)',
      price: '5.50',
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Latte (Large)');
    expect(second.price).toBe('5.5000');

    const unmapped = await repo.findUnmapped(storeId);
    expect(unmapped.filter((r) => r.externalId === 'SQ-CAT-2')).toHaveLength(1);
  });

  it('mapToMenuItem sets menuItemId and flips mappingStatus to MAPPED', async () => {
    const repo = new PosItemRepository(createScopedDb(client), organizationId);
    const item = await repo.upsert({
      id: generateId(),
      storeId,
      source: 'csv',
      externalId: 'CSV-ITEM-1',
      name: 'House Salad',
    });

    const menuItemRepo = new MenuItemRepository(createScopedDb(client), organizationId);
    const menuItem = await menuItemRepo.create({
      id: generateId(),
      name: 'House Salad',
      recipeGroupId: generateId(),
      price: '9.00',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const mapped = await repo.mapToMenuItem(item.id, menuItem.id);
    expect(mapped?.mappingStatus).toBe('MAPPED');
    expect(mapped?.menuItemId).toBe(menuItem.id);

    const stillUnmapped = await repo.findUnmapped(storeId);
    expect(stillUnmapped.some((r) => r.id === item.id)).toBe(false);
  });

  describe('markNotSeenSinceAsDelisted', () => {
    it('marks an item not re-upserted since the sync started, leaves a freshly-seen item alone', async () => {
      const repo = new PosItemRepository(createScopedDb(client), organizationId);
      const stale = await repo.upsert({
        id: generateId(),
        storeId,
        source: 'square',
        externalId: 'SQ-DELIST-STALE',
        name: 'Discontinued Muffin',
      });

      const syncStartedAt = new Date();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const fresh = await repo.upsert({
        id: generateId(),
        storeId,
        source: 'square',
        externalId: 'SQ-DELIST-FRESH',
        name: 'Still-Sold Muffin',
      });

      const delisted = await repo.markNotSeenSinceAsDelisted(storeId, 'square', syncStartedAt);
      expect(delisted.map((r) => r.id)).toContain(stale.id);
      expect(delisted.map((r) => r.id)).not.toContain(fresh.id);

      const staleRow = await repo.findById(stale.id);
      const freshRow = await repo.findById(fresh.id);
      expect(staleRow?.delistedAt).not.toBeNull();
      expect(freshRow?.delistedAt).toBeNull();
    });

    it('re-upserting a previously-delisted item clears delistedAt back to null', async () => {
      const repo = new PosItemRepository(createScopedDb(client), organizationId);
      const item = await repo.upsert({
        id: generateId(),
        storeId,
        source: 'square',
        externalId: 'SQ-RELIST',
        name: 'Seasonal Item',
      });

      await repo.markNotSeenSinceAsDelisted(storeId, 'square', new Date(Date.now() + 1000));
      const delistedRow = await repo.findById(item.id);
      expect(delistedRow?.delistedAt).not.toBeNull();

      await repo.upsert({
        id: generateId(),
        storeId,
        source: 'square',
        externalId: 'SQ-RELIST',
        name: 'Seasonal Item (back in stock)',
      });

      const relistedRow = await repo.findById(item.id);
      expect(relistedRow?.delistedAt).toBeNull();
    });

    it('does not touch items from a different source, even in the same store', async () => {
      const repo = new PosItemRepository(createScopedDb(client), organizationId);
      const csvItem = await repo.upsert({
        id: generateId(),
        storeId,
        source: 'csv',
        externalId: 'CSV-UNRELATED',
        name: 'CSV Item',
      });

      await repo.markNotSeenSinceAsDelisted(storeId, 'square', new Date(Date.now() + 1000));

      const row = await repo.findById(csvItem.id);
      expect(row?.delistedAt).toBeNull();
    });
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(posItems).where(eq(posItems.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(posItems).where(eq(posItems.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A pos_items by id', async () => {
      const repoA = new PosItemRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const item = await repoA.upsert({
        id: generateId(),
        storeId: fixture.tenantA.storeId,
        source: 'square',
        externalId: 'CROSS-TENANT-ITEM',
        name: 'Cross Tenant Item',
      });

      const repoB = new PosItemRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const seenByB = await repoB.findById(item.id);
      expect(seenByB).toBeNull();
    });

    it('the same (store, source, external_id) triple in two different stores does not collide', async () => {
      const repoA = new PosItemRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const repoB = new PosItemRepository(createScopedDb(client), fixture.tenantB.organizationId);

      const itemA = await repoA.upsert({
        id: generateId(),
        storeId: fixture.tenantA.storeId,
        source: 'square',
        externalId: 'SHARED-EXTERNAL-ID',
        name: 'Tenant A Item',
      });
      const itemB = await repoB.upsert({
        id: generateId(),
        storeId: fixture.tenantB.storeId,
        source: 'square',
        externalId: 'SHARED-EXTERNAL-ID',
        name: 'Tenant B Item',
      });

      expect(itemA.id).not.toBe(itemB.id);
    });
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new PosItemRepository(createScopedDb(client), '')).toThrow();
  });
});
