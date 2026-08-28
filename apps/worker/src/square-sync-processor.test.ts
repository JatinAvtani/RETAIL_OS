import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import {
  createDb,
  organizations,
  posConnections,
  posItems,
  stores,
  webhookEvents,
  WebhookEventRepository,
  withTenantContext,
} from '@retailos/db';
import { encryptToken } from '@retailos/pos';
import { generateId } from '@retailos/domain';
import { createSquareSyncProcessor } from './square-sync-processor';
import type { SquareSyncJobData } from '@retailos/queue';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const asJob = (data: SquareSyncJobData): Job<SquareSyncJobData> => ({ data }) as Job<SquareSyncJobData>;

const ENCRYPTION_KEY = 'test-encryption-key-for-square-sync-processor';

/**
 * The real worker-side handler for the job that replaced running Square syncs SYNCHRONOUSLY inside
 * the webhook request/manual-trigger mutations. Proves: (1) a real sync failure is recorded on the
 * SAME `webhook_events` row the route already created, AND rethrown so BullMQ's own attempts/backoff
 * still applies — this is the one property that would be trivial to get wrong (catching the error to
 * write the row, then forgetting to rethrow, would silently turn every sync failure into a
 * non-retried success from BullMQ's point of view); (2) a manually-triggered job (no
 * webhookEventId) never touches webhook_events at all.
 */
describe('square sync processor', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];
  const originalFetch = globalThis.fetch;
  let originalEnv: Record<string, string | undefined>;

  beforeAll(() => {
    originalEnv = {
      SQUARE_APPLICATION_ID: process.env.SQUARE_APPLICATION_ID,
      SQUARE_APPLICATION_SECRET: process.env.SQUARE_APPLICATION_SECRET,
      SQUARE_REDIRECT_URI: process.env.SQUARE_REDIRECT_URI,
      SQUARE_ENVIRONMENT: process.env.SQUARE_ENVIRONMENT,
      POS_TOKEN_ENCRYPTION_KEY: process.env.POS_TOKEN_ENCRYPTION_KEY,
    };
    process.env.SQUARE_APPLICATION_ID = 'test-square-app-id';
    process.env.SQUARE_APPLICATION_SECRET = 'test-square-app-secret';
    process.env.SQUARE_REDIRECT_URI = 'http://localhost:3001/integrations/square/callback';
    process.env.SQUARE_ENVIRONMENT = 'sandbox';
    process.env.POS_TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const orgId of createdOrgIds) {
      await adminDb.delete(webhookEvents).where(eq(webhookEvents.organizationId, orgId));
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(posConnections).where(eq(posConnections.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const setUpOrgWithStore = async (): Promise<{ organizationId: string; storeId: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Square Sync Processor Test Org', slug: `square-sync-proc-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' })
      )
    );
    return { organizationId, storeId };
  };

  it('a sync failure (no Square connection FOR THIS STORE) is recorded on the webhook_events row AND rethrown for BullMQ to retry', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    // A real posConnections row exists (webhook_events.posConnectionId is a real, NOT NULL FK — a
    // row must reference SOME connection), but for a DIFFERENT store than the job targets —
    // syncSquareCatalog's own findByStoreAndVendor(storeId, 'square') still finds nothing for
    // `storeId` and throws SquareNotConnectedError, same real failure this test proves the outcome
    // of.
    const otherStoreId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: otherStoreId, organizationId, name: 'Other Store', timezone: 'America/New_York' })
      )
    );
    const unrelatedConnectionId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(posConnections).values({
          id: unrelatedConnectionId,
          organizationId,
          storeId: otherStoreId,
          vendor: 'square',
          externalAccountId: 'unrelated-merchant',
          accessTokenCiphertext: encryptToken('fake-access-token', ENCRYPTION_KEY),
          refreshTokenCiphertext: encryptToken('fake-refresh-token', ENCRYPTION_KEY),
          status: 'CONNECTED',
        })
      )
    );

    const webhookEventRepository = new WebhookEventRepository(db, organizationId);
    const recorded = await webhookEventRepository.recordIfNew({
      id: generateId(),
      posConnectionId: unrelatedConnectionId,
      source: 'square',
      externalEventId: `evt-${generateId()}`,
      eventType: 'catalog.updated',
      payload: {},
    });
    if (recorded.status !== 'recorded') throw new Error('test setup: expected a fresh webhook event');

    const processor = createSquareSyncProcessor({ databaseUrl: APP_CONNECTION_STRING });

    await expect(
      processor(asJob({ kind: 'catalog', organizationId, storeId, webhookEventId: recorded.id }))
    ).rejects.toThrow(/no Square connection/i);

    const row = await webhookEventRepository.findById(recorded.id);
    expect(row?.processedAt).not.toBeNull();
    expect(row?.processingError).toMatch(/no Square connection/i);
  });

  it('a manually-triggered job (no webhookEventId) never touches webhook_events, even on failure', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();

    const processor = createSquareSyncProcessor({ databaseUrl: APP_CONNECTION_STRING });
    await expect(processor(asJob({ kind: 'catalog', organizationId, storeId }))).rejects.toThrow();

    const rows = await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.select().from(webhookEvents).where(eq(webhookEvents.organizationId, organizationId))
      )
    );
    expect(rows).toHaveLength(0);
  });

  it('a successful sync marks the webhook_events row processed with no error', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    const connectionId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(posConnections).values({
          id: connectionId,
          organizationId,
          storeId,
          vendor: 'square',
          externalAccountId: 'test-merchant',
          accessTokenCiphertext: encryptToken('fake-access-token', ENCRYPTION_KEY),
          refreshTokenCiphertext: encryptToken('fake-refresh-token', ENCRYPTION_KEY),
          status: 'CONNECTED',
        })
      )
    );

    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v2/catalog/search-catalog-objects')) {
        return new Response(JSON.stringify({ objects: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch;

    const webhookEventRepository = new WebhookEventRepository(db, organizationId);
    const recorded = await webhookEventRepository.recordIfNew({
      id: generateId(),
      posConnectionId: connectionId,
      source: 'square',
      externalEventId: `evt-${generateId()}`,
      eventType: 'catalog.updated',
      payload: {},
    });
    if (recorded.status !== 'recorded') throw new Error('test setup: expected a fresh webhook event');

    const processor = createSquareSyncProcessor({ databaseUrl: APP_CONNECTION_STRING });
    await processor(asJob({ kind: 'catalog', organizationId, storeId, webhookEventId: recorded.id }));

    const row = await webhookEventRepository.findById(recorded.id);
    expect(row?.processedAt).not.toBeNull();
    expect(row?.processingError).toBeNull();
  });
});
