import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, posConnections, stores } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { PosConnectionRepository } from './pos-connection-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('PosConnectionRepository', () => {
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
      name: 'Pos Connection Test Org',
      slug: `pos-connection-test-${organizationId}`,
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
    await adminDb.delete(posConnections).where(eq(posConnections.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('upsert inserts a new connection as CONNECTED', async () => {
    const repo = new PosConnectionRepository(createScopedDb(client), organizationId);
    const row = await repo.upsert({
      id: generateId(),
      storeId,
      vendor: 'square',
      externalAccountId: 'sq-merchant-1',
      accessTokenCiphertext: 'iv.ciphertext.tag',
      refreshTokenCiphertext: 'iv2.ciphertext2.tag2',
      tokenExpiresAt: new Date('2026-09-01T00:00:00Z'),
    });

    expect(row.status).toBe('CONNECTED');
    expect(row.externalAccountId).toBe('sq-merchant-1');
    expect(row.accessTokenCiphertext).toBe('iv.ciphertext.tag');
  });

  it('upsert on the same (store, vendor) replaces the connection in place, not a duplicate row', async () => {
    const repo = new PosConnectionRepository(createScopedDb(client), organizationId);
    const first = await repo.upsert({
      id: generateId(),
      storeId,
      vendor: 'square',
      externalAccountId: 'sq-merchant-old',
      accessTokenCiphertext: 'old-ciphertext',
    });
    const second = await repo.upsert({
      id: generateId(),
      storeId,
      vendor: 'square',
      externalAccountId: 'sq-merchant-new',
      accessTokenCiphertext: 'new-ciphertext',
    });

    expect(second.id).toBe(first.id);
    expect(second.externalAccountId).toBe('sq-merchant-new');
    expect(second.accessTokenCiphertext).toBe('new-ciphertext');

    const all = await repo.findAllForOrganization();
    expect(all.filter((c) => c.storeId === storeId && c.vendor === 'square')).toHaveLength(1);
  });

  it('reconnecting after a disconnect clears disconnectedAt and lastError, sets status back to CONNECTED', async () => {
    const repo = new PosConnectionRepository(createScopedDb(client), organizationId);
    const created = await repo.upsert({
      id: generateId(),
      storeId,
      vendor: 'square',
      externalAccountId: 'sq-merchant-1',
      accessTokenCiphertext: 'ciphertext-1',
    });
    await repo.updateStatus(created.id, 'FAILED', 'token refresh failed');
    await repo.disconnect(created.id);

    const reconnected = await repo.upsert({
      id: generateId(),
      storeId,
      vendor: 'square',
      externalAccountId: 'sq-merchant-1',
      accessTokenCiphertext: 'ciphertext-2',
    });

    expect(reconnected.status).toBe('CONNECTED');
    expect(reconnected.lastError).toBeNull();
    expect(reconnected.disconnectedAt).toBeNull();
  });

  it('recordSuccessfulSync sets lastSuccessfulSyncAt and resets status/lastError', async () => {
    const repo = new PosConnectionRepository(createScopedDb(client), organizationId);
    const created = await repo.upsert({
      id: generateId(),
      storeId,
      vendor: 'square',
      externalAccountId: 'sq-merchant-1',
      accessTokenCiphertext: 'ciphertext',
    });
    await repo.updateStatus(created.id, 'DEGRADED', 'partial sync failure');

    const synced = await repo.recordSuccessfulSync(created.id);
    expect(synced?.status).toBe('CONNECTED');
    expect(synced?.lastError).toBeNull();
    expect(synced?.lastSuccessfulSyncAt).not.toBeNull();
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(posConnections).where(eq(posConnections.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(posConnections).where(eq(posConnections.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A pos_connections by id', async () => {
      const repoA = new PosConnectionRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.upsert({
        id: generateId(),
        storeId: fixture.tenantA.storeId,
        vendor: 'square',
        externalAccountId: 'sq-cross-tenant',
        accessTokenCiphertext: 'ciphertext',
      });

      const repoB = new PosConnectionRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const seenByB = await repoB.findById(created.id);
      expect(seenByB).toBeNull();
    });

    it('the same store+vendor pair in two different tenants are independent, non-colliding connections', async () => {
      const repoA = new PosConnectionRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const repoB = new PosConnectionRepository(createScopedDb(client), fixture.tenantB.organizationId);

      const connA = await repoA.upsert({
        id: generateId(),
        storeId: fixture.tenantA.storeId,
        vendor: 'square',
        externalAccountId: 'sq-tenant-a',
        accessTokenCiphertext: 'ciphertext-a',
      });
      const connB = await repoB.upsert({
        id: generateId(),
        storeId: fixture.tenantB.storeId,
        vendor: 'square',
        externalAccountId: 'sq-tenant-b',
        accessTokenCiphertext: 'ciphertext-b',
      });

      expect(connA.id).not.toBe(connB.id);
    });
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new PosConnectionRepository(createScopedDb(client), '')).toThrow();
  });
});
