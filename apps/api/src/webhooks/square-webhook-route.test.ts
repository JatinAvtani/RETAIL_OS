import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, organizations, posConnections, posItems, salesTransactions, stores, webhookEvents } from '@retailos/db';
import { encryptToken } from '@retailos/pos';
import { generateId } from '@retailos/domain';
import { buildServer } from '../server';
import type { FastifyInstance } from 'fastify';

const NOTIFICATION_URL = 'http://localhost:3001/webhooks/square';
const SIGNING_KEY = 'test-square-webhook-signing-key';

const sign = (rawBody: string): string =>
  createHmac('sha256', SIGNING_KEY).update(NOTIFICATION_URL + rawBody, 'utf8').digest('base64');

/**
 * 006-06: real HTTP verification for the Square webhook receiver. `global.fetch` is patched
 * (Square's host only) for the tests that let the triggered sync actually run — same standing
 * limitation as 006-04/006-05 (no live Square sandbox app exists yet).
 */
describe('POST /webhooks/square', () => {
  let app: FastifyInstance;
  let originalEnv: Record<string, string | undefined>;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const createdOrgIds: string[] = [];
  const originalFetch = globalThis.fetch;

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

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
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

  const stubSquareEmptyResponse = (): void => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v2/orders/search')) {
        return new Response(JSON.stringify({ orders: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v2/catalog/search-catalog-objects')) {
        return new Response(JSON.stringify({ objects: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch;
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

  it('a genuinely valid, known-merchant order event is recorded, triggers the matching sync, and marks itself processed', async () => {
    const { organizationId, merchantId } = await setUpConnectedOrg();
    stubSquareEmptyResponse();
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
    expect(rows[0]!.processedAt).not.toBeNull();
    expect(rows[0]!.processingError).toBeNull();
  });

  it('replaying the SAME event id is deduped — one row, not reprocessed', async () => {
    const { organizationId, merchantId } = await setUpConnectedOrg();
    stubSquareEmptyResponse();
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
  });

  it('a catalog.version.updated event triggers a catalog sync, not an orders sync', async () => {
    const { organizationId, merchantId } = await setUpConnectedOrg();
    stubSquareEmptyResponse();
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
    expect(rows[0]!.processedAt).not.toBeNull();
  });

  it('a genuinely valid event whose triggered sync fails still returns 200, with the failure recorded on the row', async () => {
    const { organizationId, merchantId } = await setUpConnectedOrg();
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    const eventId = generateId();
    const body = orderEventBody(merchantId, eventId);
    const signature = sign(body);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
    });

    expect(response.statusCode).toBe(200); // the webhook itself was valid — the response reflects receipt, not the sync's outcome
    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.organizationId, organizationId));
    expect(rows[0]!.processedAt).not.toBeNull();
    expect(rows[0]!.processingError).not.toBeNull();
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
