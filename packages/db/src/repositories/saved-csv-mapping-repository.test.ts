import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, savedCsvColumnMappings } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SavedCsvMappingRepository } from './saved-csv-mapping-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SavedCsvMappingRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Saved CSV Mapping Test Org',
      slug: `saved-csv-mapping-test-${organizationId}`,
      baseCurrency: 'USD',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(savedCsvColumnMappings).where(eq(savedCsvColumnMappings.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('upsert creates a new mapping under a label', async () => {
    const repo = new SavedCsvMappingRepository(createScopedDb(client), organizationId);
    const mapping = { occurredAt: 'date', posItemName: 'item', quantity: 'qty', unitPrice: 'price' };
    const row = await repo.upsert('Toast export', mapping);
    expect(row.label).toBe('Toast export');
    expect(row.columnMapping).toEqual(mapping);
  });

  it('upsert on the same label replaces the mapping in place, not a duplicate row', async () => {
    const repo = new SavedCsvMappingRepository(createScopedDb(client), organizationId);
    const first = await repo.upsert('Toast export', { occurredAt: 'date', posItemName: 'item', quantity: 'qty', unitPrice: 'price' });
    const second = await repo.upsert('Toast export', { occurredAt: 'Date', posItemName: 'Item', quantity: 'Qty', unitPrice: 'Price' });

    expect(second.id).toBe(first.id);
    expect(second.columnMapping).toEqual({ occurredAt: 'Date', posItemName: 'Item', quantity: 'Qty', unitPrice: 'Price' });

    const all = await repo.findAllForOrganization();
    expect(all.filter((m) => m.label === 'Toast export')).toHaveLength(1);
  });

  it('findByLabel returns null when no mapping exists under that label', async () => {
    const repo = new SavedCsvMappingRepository(createScopedDb(client), organizationId);
    const found = await repo.findByLabel('Never saved');
    expect(found).toBeNull();
  });

  it('two different labels in the same org coexist as separate rows', async () => {
    const repo = new SavedCsvMappingRepository(createScopedDb(client), organizationId);
    await repo.upsert('Toast export', { occurredAt: 'date', posItemName: 'item', quantity: 'qty', unitPrice: 'price' });
    await repo.upsert('Lightspeed weekly', { occurredAt: 'Sale Date', posItemName: 'Product', quantity: 'Units', unitPrice: 'Unit Price' });
    const all = await repo.findAllForOrganization();
    expect(all).toHaveLength(2);
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(savedCsvColumnMappings).where(eq(savedCsvColumnMappings.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(savedCsvColumnMappings).where(eq(savedCsvColumnMappings.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A saved mapping by label', async () => {
      const repoA = new SavedCsvMappingRepository(createScopedDb(client), fixture.tenantA.organizationId);
      await repoA.upsert('Toast export', { occurredAt: 'date', posItemName: 'item', quantity: 'qty', unitPrice: 'price' });

      const repoB = new SavedCsvMappingRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const seenByB = await repoB.findByLabel('Toast export');
      expect(seenByB).toBeNull();
    });

    it('the same label in two different tenants are independent, non-colliding rows', async () => {
      const repoA = new SavedCsvMappingRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const repoB = new SavedCsvMappingRepository(createScopedDb(client), fixture.tenantB.organizationId);

      const mappingA = await repoA.upsert('Toast export', { occurredAt: 'date', posItemName: 'item', quantity: 'qty', unitPrice: 'price' });
      const mappingB = await repoB.upsert('Toast export', { occurredAt: 'Date', posItemName: 'Item', quantity: 'Qty', unitPrice: 'Price' });

      expect(mappingA.id).not.toBe(mappingB.id);
    });
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new SavedCsvMappingRepository(createScopedDb(client), '')).toThrow();
  });
});
