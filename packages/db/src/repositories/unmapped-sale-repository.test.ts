import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { menuItems, organizations, stores, unmappedSales } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { UnmappedSaleRepository } from './unmapped-sale-repository';
import { MenuItemRepository } from './menu-item-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('UnmappedSaleRepository', () => {
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
      name: 'Unmapped Sale Test Org',
      slug: `unmapped-sale-test-${organizationId}`,
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
    await adminDb.delete(unmappedSales).where(eq(unmappedSales.organizationId, organizationId));
    await adminDb.delete(menuItems).where(eq(menuItems.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('quarantines an unmapped sale line with revenue recorded, status UNRESOLVED', async () => {
    const repo = new UnmappedSaleRepository(createScopedDb(client), organizationId);
    const row = await repo.quarantine({
      storeId,
      posItemExternalId: 'SQ-ITEM-123',
      posItemName: 'Mystery Combo',
      quantitySold: '3',
      revenue: '17.97',
      currency: 'USD',
      occurredAt: new Date('2026-01-05T12:00:00Z'),
      sourceType: 'pos-sync',
    });

    expect(row.status).toBe('UNRESOLVED');
    expect(row.revenue).toBe('17.9700');
    expect(row.resolvedMenuItemId).toBeNull();
  });

  it('lists only UNRESOLVED rows in findUnresolved, oldest first', async () => {
    const repo = new UnmappedSaleRepository(createScopedDb(client), organizationId);
    const older = await repo.quarantine({
      storeId,
      posItemExternalId: 'SQ-ITEM-OLD',
      posItemName: 'Old Item',
      quantitySold: '1',
      revenue: '5.00',
      currency: 'USD',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      sourceType: 'pos-sync',
    });
    const newer = await repo.quarantine({
      storeId,
      posItemExternalId: 'SQ-ITEM-NEW',
      posItemName: 'New Item',
      quantitySold: '1',
      revenue: '6.00',
      currency: 'USD',
      occurredAt: new Date('2026-01-02T00:00:00Z'),
      sourceType: 'pos-sync',
    });
    const menuItemRepo = new MenuItemRepository(createScopedDb(client), organizationId);
    const menuItem = await menuItemRepo.create({
      id: generateId(),
      name: 'Resolved Item',
      recipeGroupId: generateId(),
      price: '6.00',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.resolve(newer.id, menuItem.id, generateId());

    const unresolved = await repo.findUnresolved(storeId);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.id).toBe(older.id);
  });

  it('resolve() sets status RESOLVED, resolvedMenuItemId, and resolvedAt', async () => {
    const repo = new UnmappedSaleRepository(createScopedDb(client), organizationId);
    const row = await repo.quarantine({
      storeId,
      posItemExternalId: 'SQ-ITEM-456',
      posItemName: 'Burger Combo',
      quantitySold: '2',
      revenue: '20.00',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });

    const menuItemRepo = new MenuItemRepository(createScopedDb(client), organizationId);
    const menuItem = await menuItemRepo.create({
      id: generateId(),
      name: 'Burger Combo Item',
      recipeGroupId: generateId(),
      price: '10.00',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });
    const resolverUserId = generateId();
    const resolved = await repo.resolve(row.id, menuItem.id, resolverUserId);

    expect(resolved?.status).toBe('RESOLVED');
    expect(resolved?.resolvedMenuItemId).toBe(menuItem.id);
    expect(resolved?.resolvedByUserId).toBe(resolverUserId);
    expect(resolved?.resolvedAt).not.toBeNull();
  });

  it('ignore() sets status IGNORED without ever setting resolvedMenuItemId', async () => {
    const repo = new UnmappedSaleRepository(createScopedDb(client), organizationId);
    const row = await repo.quarantine({
      storeId,
      posItemExternalId: 'SQ-GIFT-CARD',
      posItemName: 'Gift Card',
      quantitySold: '1',
      revenue: '25.00',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });

    const ignored = await repo.ignore(row.id, generateId());

    expect(ignored?.status).toBe('IGNORED');
    expect(ignored?.resolvedMenuItemId).toBeNull();
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      // fixture.cleanup() deletes stores/orgs; unmapped_sales rows this describe block inserted
      // must go first, or the store FK blocks the delete (real bug caught by running this test).
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(unmappedSales).where(eq(unmappedSales.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(unmappedSales).where(eq(unmappedSales.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A quarantined rows via findUnresolved', async () => {
      const repoA = new UnmappedSaleRepository(createScopedDb(client), fixture.tenantA.organizationId);
      await repoA.quarantine({
        storeId: fixture.tenantA.storeId,
        posItemExternalId: 'SQ-CROSS-TENANT',
        posItemName: 'Cross Tenant Item',
        quantitySold: '1',
        revenue: '9.99',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
      });

      const repoB = new UnmappedSaleRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const rowsForB = await repoB.findUnresolved();
      expect(rowsForB.every((r) => r.posItemExternalId !== 'SQ-CROSS-TENANT')).toBe(true);
    });

    it('tenant B cannot resolve tenant A row by id', async () => {
      const repoA = new UnmappedSaleRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const row = await repoA.quarantine({
        storeId: fixture.tenantA.storeId,
        posItemExternalId: 'SQ-CROSS-RESOLVE',
        posItemName: 'Cross Resolve Item',
        quantitySold: '1',
        revenue: '4.50',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
      });

      const repoB = new UnmappedSaleRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const result = await repoB.resolve(row.id, generateId(), generateId());
      expect(result).toBeNull();

      const stillUnresolved = await repoA.findById(row.id);
      expect(stillUnresolved?.status).toBe('UNRESOLVED');
    });
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new UnmappedSaleRepository(createScopedDb(client), '')).toThrow();
  });
});
