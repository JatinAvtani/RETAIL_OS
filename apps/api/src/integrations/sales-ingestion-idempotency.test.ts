import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  organizations,
  posConnections,
  posItems,
  salesTransactionLines,
  salesTransactions,
  outboxEvents,
  webhookEvents,
  unmappedSales,
  stockMovements,
  stockLevels,
  lots,
  stores,
} from '@retailos/db';
import { encryptToken } from '@retailos/pos';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../server';
import type { FastifyInstance } from 'fastify';

const NOTIFICATION_URL = 'http://localhost:3001/webhooks/square';
const SIGNING_KEY = 'test-square-webhook-signing-key-idempotency';

/**
 * The requirement ("Idempotent ingestion — dedupe by source id. Retries must not double-count").
 * Single-retry idempotency for one code path at a time is already proven three times over
 * (`packages/db/src/repositories/sales-transaction-repository.test.ts`'s `recordIfNew`,
 * `integrations.test.ts`'s catalog re-sync, `integrations-orders.test.ts`'s order re-sync). What
 * none of those prove — and what the plan names explicitly as the real risk ("retries, backfills,
 * and OVERLAPPING WINDOWS must be safe by construction, not by luck") — is idempotency ACROSS
 * different ingestion paths converging on the same real-world order, and a genuinely multi-page
 * backfill whose window overlaps a prior sync's already-ingested data. This file proves both.
 */
describe('sales ingestion idempotency across paths', () => {
  let app: FastifyInstance;
  let originalEnv: Record<string, string | undefined>;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sessionStore = new SessionStore(redis);
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
    process.env.POS_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-for-idempotency-test';
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
      // syncSquareOrders now genuinely triggers consumption per line — real
      // unmapped_sales/stock_movements/stock_levels/lots writes, not hypothetical ones.
      await db.delete(unmappedSales).where(eq(unmappedSales.organizationId, orgId));
      await db.delete(webhookEvents).where(eq(webhookEvents.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await db.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await db.delete(lots).where(eq(lots.organizationId, orgId));
      await db.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
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
    await redis.quit();
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
      name: `Idempotency Test Org ${organizationId}`,
      slug: `idempotency-test-org-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });
    const merchantId = `idempotency-test-merchant-${organizationId}`;
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

  const issueSession = async (organizationId: string): Promise<string> => {
    const { token } = await sessionStore.create(
      { userId: generateId(), organizationId, storeIds: 'ALL', role: 'OWNER', permissions: [] },
      '127.0.0.1',
      'test-agent'
    );
    return token;
  };

  const sign = (rawBody: string): string =>
    createHmac('sha256', SIGNING_KEY).update(NOTIFICATION_URL + rawBody, 'utf8').digest('base64');

  const orderWire = (externalId: string) => ({
    id: externalId,
    location_id: 'LOC-1',
    created_at: '2026-08-02T12:00:00Z',
    updated_at: '2026-08-02T12:00:00Z',
    state: 'COMPLETED',
    line_items: [
      {
        uid: `${externalId}-LINE-1`,
        catalog_object_id: 'VAR-1',
        name: 'Cappuccino',
        quantity: '1',
        base_price_money: { amount: 450, currency: 'USD' },
        total_money: { amount: 450, currency: 'USD' },
      },
    ],
    total_money: { amount: 450, currency: 'USD' },
    total_tax_money: { amount: 36, currency: 'USD' },
    total_discount_money: { amount: 0, currency: 'USD' },
  });

  const stubSquareOrdersResponsesInSequence = (pages: unknown[]): void => {
    let call = 0;
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v2/orders/search')) {
        const body = pages[Math.min(call, pages.length - 1)];
        call += 1;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch;
  };

  it('an order delivered first via webhook, then re-seen by a manual orders sync of an overlapping window, is recorded exactly once', async () => {
    const { organizationId, merchantId } = await setUpConnectedOrg();
    const sessionCookie = await issueSession(organizationId);
    const orderId = 'CROSS-PATH-ORDER-1';

    // Path 1: the webhook delivers the order.
    const webhookBody = JSON.stringify({
      merchant_id: merchantId,
      type: 'order.updated',
      event_id: generateId(),
      data: { type: 'order_updated', id: orderId, object: { order_updated: { order_id: orderId, location_id: 'LOC-1', state: 'COMPLETED', version: 1 } } },
    });
    stubSquareOrdersResponsesInSequence([{ orders: [orderWire(orderId)] }]);
    const webhookResponse = await app.inject({
      method: 'POST',
      url: '/webhooks/square',
      payload: webhookBody,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': sign(webhookBody) },
    });
    expect(webhookResponse.statusCode).toBe(200);

    // Path 2: a manual orders sync re-fetches a window that includes the SAME order again
    // (the realistic "webhook succeeded, but the next scheduled/manual sync's window still
    // overlaps it" case — not a retried request, a genuinely different code path).
    stubSquareOrdersResponsesInSequence([{ orders: [orderWire(orderId)] }]);
    const syncResponse = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId: (await db.select().from(stores).where(eq(stores.organizationId, organizationId)))[0]!.id },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(syncResponse.statusCode).toBe(200);
    const syncBody = JSON.parse(syncResponse.body).result.data;
    expect(syncBody.transactionsRecorded).toBe(0);
    expect(syncBody.transactionsDuplicate).toBe(1);

    // The load-bearing assertion: exactly ONE sales_transactions row and ONE outbox event, no
    // matter which of the two paths "got there first" or how many times each is retried.
    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(txRows).toHaveLength(1);
    const outboxRows = await db.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    expect(outboxRows).toHaveLength(1);
  });

  it('a multi-page orders backfill whose SECOND page overlaps orders the FIRST page already ingested is still exactly-once', async () => {
    const { organizationId, storeId } = await setUpConnectedOrg();
    const sessionCookie = await issueSession(organizationId);

    // Page 1: orders A and B, with a cursor to page 2.
    // Page 2 (simulating a vendor-side window overlap, or a retried page after a transient
    // failure): orders B and C again — B is a genuine repeat within the SAME sync run.
    stubSquareOrdersResponsesInSequence([
      { orders: [orderWire('BACKFILL-A'), orderWire('BACKFILL-B')], cursor: 'page-2-cursor' },
      { orders: [orderWire('BACKFILL-B'), orderWire('BACKFILL-C')] },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.transactionsRecorded).toBe(3); // A, B, C each recorded exactly once
    expect(body.transactionsDuplicate).toBe(1); // B's second appearance

    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(txRows).toHaveLength(3);
    const externalIds = txRows.map((r) => r.externalId).sort();
    expect(externalIds).toEqual(['BACKFILL-A', 'BACKFILL-B', 'BACKFILL-C']);
  });

  it('the same catalog item synced twice across two independent sync runs converges on one pos_items row, not two', async () => {
    const { organizationId, storeId } = await setUpConnectedOrg();
    const sessionCookie = await issueSession(organizationId);

    const catalogPage = {
      objects: [
        {
          id: 'ITEM-OVERLAP-1',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Muffin',
            variations: [
              {
                id: 'VAR-OVERLAP-1',
                type: 'ITEM_VARIATION',
                item_variation_data: { name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 275, currency: 'USD' } },
              },
            ],
          },
        },
      ],
    };
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v2/catalog/search-catalog-objects')) {
        return new Response(JSON.stringify(catalogPage), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch;

    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/trpc/integrations.syncSquareCatalog',
        payload: { storeId },
        cookies: { '__Host-session': sessionCookie },
      });
      expect(response.statusCode).toBe(200);
    }

    const itemRows = await db.select().from(posItems).where(eq(posItems.organizationId, organizationId));
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0]!.externalId).toBe('VAR-OVERLAP-1');
  });
});
