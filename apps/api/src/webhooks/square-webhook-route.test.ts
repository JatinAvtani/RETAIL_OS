import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, organizations, posConnections, posItems, salesTransactions, stores, webhookEvents } from '@retailos/db';
import { encryptToken } from '@retailos/pos';
import { generateId } from '@retailos/domain';
import { buildServer } from '../server';
import { squareSyncQueue } from '../trpc/context';
import type { FastifyInstance } from 'fastify';

const NOTIFICATION_URL = 'http://localhost:3001/webhooks/square';
const SIGNING_KEY = 'test-square-webhook-signing-key';

const sign = (rawBody: string): string =>
  createHmac('sha256', SIGNING_KEY).update(NOTIFICATION_URL + rawBody, 'utf8').digest('base64');

/**
 * real HTTP verification for the Square webhook receiver. The route now ENQUEUES a
 * `SquareSyncJobData` job instead of running the sync inline (see `square-sync-queue.ts`'s own doc
 * comment for why) — `apps/worker`'s `square-sync-processor.test.ts` proves the worker side (the
 * sync actually running, `webhook_events.processedAt`/`processingError` being set once it
 * finishes); this file proves the ROUTE's own auth/dedup/enqueue behavior, which is everything it
 * still does synchronously.
 */
describe('POST /webhooks/square', () => {
  let app: FastifyInstance;
  let originalEnv: Record<string, string | undefined>;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    originalEnv = {
      SQUARE_APPLICATION_ID: process.env.SQUARE_APPLICATION_ID,
      SQUARE_APPLICATION_SECRET: process.env.SQUARE_APPLICATION_SECRET,
      SQUARE_REDIRECT_URI: process.env.SQUARE_REDIRECT_URI,
      SQUARE_ENVIRONMENT: process.env.SQUARE_ENVIRONMENT,
      POS_TOKEN_ENCRYPTION_KEY: process.env.POS_TOKEN_ENCRYPTION_KEY,
      SQUARE_WEBHOOK_SIGNATURE_KEY: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      SQUARE_WEBHOOK_NOTIFICATION_URL: process.env.SQUARE_WEBHOOK_NOTIFICATION_URL,
    };
    process.env.SQUARE_APPLICATION_ID = 'test-square-app-id';
    process.env.SQUARE_APPLICATION_SECRET = 'test-square-app-secret';
    process.env.SQUARE_REDIRECT_URI = 'http://localhost:3001/integrations/square/callback';
    process.env.SQUARE_ENVIRONMENT = 'sandbox';
    process.env.POS_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-for-webhook-test';
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = SIGNING_KEY;
    process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = NOTIFICATION_URL;

    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await db.delete(webhookEvents).where(eq(webhookEvents.organizationId, orgId));
      await db.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await db.delete(posItems).where(eq(posItems.organizationId, orgId));
      await db.delete(posConnections).where(eq(posConnections.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const setUpConnectedOrg = async (): Promise<{ organizationId: string; storeId: string; merchantId: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Webhook Test Org ${organizationId}`,
      slug: `webhook-test-org-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });
    const merchantId = `webhook-test-merchant-${organizationId}`;
    await db.insert(posConnections).values({
      id: generateId(),
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: merchantId,
      externalLocationId: 'LOC-1',
      accessTokenCiphertext: encryptToken('fake-access-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
      refreshTokenCiphertext: encryptToken('fake-refresh-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
      status: 'CONNECTED',
    });
    return { organizationId, storeId, merchantId };
  };

  const orderEventBody = (merchantId: string, eventId: string): string =>
    JSON.stringify({
      merchant_id: merchantId,
      type: 'order.updated',
      event_id: eventId,
      created_at: '2026-08-05T00:00:00Z',
      data: {
        type: 'order_updated',
        id: 'ORDER-1',
        object: { order_updated: { order_id: 'ORDER-1', location_id: 'LOC-1', state: 'COMPLETED', version: 1 } },
      },
    });

  it('rejects a request with no signature header', async () => {
    const { merchantId } = await setUpConnectedOrg();
    const body = orderEventBody(merchantId, generateId());

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a request with an invalid signature', async () => {
    const { merchantId } = await setUpConnectedOrg();
    const body = orderEventBody(merchantId, generateId());

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': 'forged-signature' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('accepts a genuinely correctly-signed request for an unknown merchant_id — 200, but no webhook_events row', async () => {
    const body = orderEventBody('never-connected-merchant', generateId());
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
    });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.externalEventId, JSON.parse(body).event_id));
    expect(rows).toHaveLength(0);
  });

  it('a genuinely valid, known-merchant order event is recorded and enqueues a real orders sync job, still UNPROCESSED at response time', async () => {
    const { organizationId, storeId, merchantId } = await setUpConnectedOrg();
    const eventId = generateId();
    const body = orderEventBody(merchantId, eventId);
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
    });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalEventId).toBe(eventId);
    expect(rows[0]!.eventType).toBe('transaction.updated');
    // The route no longer runs the sync inline — processedAt stays null until the worker
    // processor (apps/worker/src/square-sync-processor.ts, tested there) actually runs it.
    expect(rows[0]!.processedAt).toBeNull();

    const jobs = await squareSyncQueue.getJobs(['waiting', 'active', 'delayed']);
    const matching = jobs.find((j) => j.data.organizationId === organizationId && j.data.storeId === storeId);
    expect(matching).toBeDefined();
    expect(matching!.data.kind).toBe('orders');
    expect(matching!.data.webhookEventId).toBe(rows[0]!.id);
    await matching!.remove();
  });

  it('replaying the SAME event id is deduped — one row, not re-enqueued', async () => {
    const { organizationId, merchantId } = await setUpConnectedOrg();
    const eventId = generateId();
    const body = orderEventBody(merchantId, eventId);
    const signature = sign(body);

    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).duplicate).toBe(true);

    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.organizationId, organizationId));
    expect(rows).toHaveLength(1);

    const jobs = await squareSyncQueue.getJobs(['waiting', 'active', 'delayed']);
    const matching = jobs.filter((j) => j.data.organizationId === organizationId);
    expect(matching).toHaveLength(1); // one enqueue, not two, for the duplicate delivery
    await Promise.all(matching.map((j) => j.remove()));
  });

  it('a catalog.version.updated event records catalog.updated and enqueues a real catalog sync job, not an orders one', async () => {
    const { organizationId, storeId, merchantId } = await setUpConnectedOrg();
    const body = JSON.stringify({
      merchant_id: merchantId,
      type: 'catalog.version.updated',
      event_id: generateId(),
      data: { type: 'catalog_version', id: 'CATVER-1', object: { catalog_version: { updated_at: '2026-08-05T00:00:00Z' } } },
    });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
    });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.organizationId, organizationId));
    expect(rows[0]!.eventType).toBe('catalog.updated');
    expect(rows[0]!.processedAt).toBeNull(); // not run inline — the worker processor sets this once it actually runs

    const jobs = await squareSyncQueue.getJobs(['waiting', 'active', 'delayed']);
    const matching = jobs.find((j) => j.data.organizationId === organizationId && j.data.storeId === storeId);
    expect(matching).toBeDefined();
    expect(matching!.data.kind).toBe('catalog');
    await matching!.remove();
  });

  it('a genuinely valid event still returns 200 and enqueues, regardless of how the eventual sync turns out — the route cannot know yet', async () => {
    // The exact scenario this route used to observe synchronously (a downstream sync failure) is
    // now apps/worker/src/square-sync-processor.test.ts's own concern — this route commits to
    // nothing about the sync's eventual outcome, which is the whole point of moving it off the
    // request path (Square's own 10s webhook timeout no longer bounds how long a real sync can
    // take).
    const { organizationId, storeId, merchantId } = await setUpConnectedOrg();
    const eventId = generateId();
    const body = orderEventBody(merchantId, eventId);
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
    });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.organizationId, organizationId));
    expect(rows[0]!.processedAt).toBeNull();
    expect(rows[0]!.processingError).toBeNull();

    const jobs = await squareSyncQueue.getJobs(['waiting', 'active', 'delayed']);
    const matching = jobs.find((j) => j.data.organizationId === organizationId && j.data.storeId === storeId);
    expect(matching).toBeDefined();
    await matching!.remove();
  });

  it('an unrecognized event type is accepted (200) but not recorded', async () => {
    const { merchantId } = await setUpConnectedOrg();
    const body = JSON.stringify({ merchant_id: merchantId, type: 'some.future.event', event_id: generateId() });
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).parsed).toBe(false);
  });
});
