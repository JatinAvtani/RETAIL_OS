import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, posConnections, stores, webhookEvents } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { WebhookEventRepository } from './webhook-event-repository';
import { PosConnectionLookup } from './pos-connection-lookup';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('WebhookEventRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let connectionId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Webhook Event Test Org',
      slug: `webhook-event-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    connectionId = generateId();
    await adminDb.insert(posConnections).values({
      id: connectionId,
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: `webhook-test-merchant-${organizationId}`,
      accessTokenCiphertext: 'fake-ciphertext',
      status: 'CONNECTED',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(webhookEvents).where(eq(webhookEvents.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(posConnections).where(eq(posConnections.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('recordIfNew inserts a new event', async () => {
    const repo = new WebhookEventRepository(createScopedDb(client), organizationId);
    const result = await repo.recordIfNew({
      id: generateId(),
      posConnectionId: connectionId,
      source: 'square',
      externalEventId: 'EVT-1',
      eventType: 'transaction.updated',
      payload: { event_id: 'EVT-1' },
    });

    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') throw new Error('unreachable');
    const row = await repo.findById(result.id);
    expect(row?.externalEventId).toBe('EVT-1');
    expect(row?.processedAt).toBeNull();
  });

  it('recordIfNew on the same (organization, source, external_event_id) is a genuine no-op — real idempotency proof', async () => {
    const repo = new WebhookEventRepository(createScopedDb(client), organizationId);
    const first = await repo.recordIfNew({
      id: generateId(),
      posConnectionId: connectionId,
      source: 'square',
      externalEventId: 'EVT-DUPLICATE',
      eventType: 'transaction.updated',
      payload: { event_id: 'EVT-DUPLICATE' },
    });
    const second = await repo.recordIfNew({
      id: generateId(), // a genuinely different row id — proves the constraint, not accidental id reuse
      posConnectionId: connectionId,
      source: 'square',
      externalEventId: 'EVT-DUPLICATE',
      eventType: 'transaction.updated',
      payload: { event_id: 'EVT-DUPLICATE', retried: true },
    });

    expect(first.status).toBe('recorded');
    expect(second.status).toBe('duplicate');

    const adminDb = drizzle(adminClient, { schema });
    const rows = await adminDb.select().from(webhookEvents).where(eq(webhookEvents.externalEventId, 'EVT-DUPLICATE'));
    expect(rows).toHaveLength(1); // no duplicate row
  });

  it('markProcessed records success with no error', async () => {
    const repo = new WebhookEventRepository(createScopedDb(client), organizationId);
    const result = await repo.recordIfNew({
      id: generateId(),
      posConnectionId: connectionId,
      source: 'square',
      externalEventId: 'EVT-PROCESSED-OK',
      eventType: 'catalog.updated',
      payload: {},
    });
    if (result.status !== 'recorded') throw new Error('unreachable');

    const updated = await repo.markProcessed(result.id);
    expect(updated?.processedAt).not.toBeNull();
    expect(updated?.processingError).toBeNull();
  });

  it('markProcessed records a real failure message', async () => {
    const repo = new WebhookEventRepository(createScopedDb(client), organizationId);
    const result = await repo.recordIfNew({
      id: generateId(),
      posConnectionId: connectionId,
      source: 'square',
      externalEventId: 'EVT-PROCESSED-FAIL',
      eventType: 'catalog.updated',
      payload: {},
    });
    if (result.status !== 'recorded') throw new Error('unreachable');

    const updated = await repo.markProcessed(result.id, 'Square catalog fetch failed: 500');
    expect(updated?.processedAt).not.toBeNull();
    expect(updated?.processingError).toBe('Square catalog fetch failed: 500');
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(webhookEvents).where(eq(webhookEvents.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(webhookEvents).where(eq(webhookEvents.organizationId, fixture.tenantB.organizationId));
      await adminDb.delete(posConnections).where(eq(posConnections.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(posConnections).where(eq(posConnections.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A webhook_events by id', async () => {
      const adminDb = drizzle(adminClient, { schema });
      const connA = generateId();
      await adminDb.insert(posConnections).values({
        id: connA,
        organizationId: fixture.tenantA.organizationId,
        storeId: fixture.tenantA.storeId,
        vendor: 'square',
        externalAccountId: `cross-tenant-merchant-${connA}`,
        accessTokenCiphertext: 'fake',
        status: 'CONNECTED',
      });

      const repoA = new WebhookEventRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.recordIfNew({
        id: generateId(),
        posConnectionId: connA,
        source: 'square',
        externalEventId: 'CROSS-TENANT-EVT',
        eventType: 'transaction.updated',
        payload: {},
      });
      if (created.status !== 'recorded') throw new Error('unreachable');

      const repoB = new WebhookEventRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const seenByB = await repoB.findById(created.id);
      expect(seenByB).toBeNull();
    });
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new WebhookEventRepository(createScopedDb(client), '')).toThrow();
  });
});

describe('PosConnectionLookup', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let connectionId: string;
  const merchantId = `lookup-test-merchant-${generateId()}`;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Connection Lookup Test Org',
      slug: `connection-lookup-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });
    connectionId = generateId();
    await adminDb.insert(posConnections).values({
      id: connectionId,
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: merchantId,
      accessTokenCiphertext: 'fake-ciphertext',
      status: 'CONNECTED',
    });
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(posConnections).where(eq(posConnections.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('finds a real connection by (vendor, external_account_id) with NO org context set — the whole point of this pre-tenant-context lookup', async () => {
    const db = drizzle(client, { schema }); // a plain, unscoped connection — no app.current_org_id ever set
    const lookup = new PosConnectionLookup(db);
    const result = await lookup.findByExternalAccount('square', merchantId);
    expect(result).toEqual({ id: connectionId, organizationId, storeId });
  });

  it('returns null for a merchant_id with no matching connection, not an error', async () => {
    const db = drizzle(client, { schema });
    const lookup = new PosConnectionLookup(db);
    const result = await lookup.findByExternalAccount('square', 'never-existed-merchant-id');
    expect(result).toBeNull();
  });
});
