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
  stores,
  unmappedSales,
  stockMovements,
  stockLevels,
  lots,
} from '@retailos/db';
import { encryptToken } from '@retailos/pos';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * real HTTP verification for `integrations.reconcileSquareOrders`. `global.fetch` is
 * patched (Square's own host only) — no live Square sandbox app exists yet, same standing
 * limitation as every other Square-touching task since earlier work. This file specifically proves the
 * two things that make reconciliation different from a plain re-run of `syncSquareOrders`: it finds
 * an order the incremental sync's own watermark would never revisit, and it never perturbs
 * `ordersSyncCursor`/`ordersSyncWatermark` — those belong solely to the incremental sync.
 */
describe('integrations.reconcileSquareOrders', () => {
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
    };
    process.env.SQUARE_APPLICATION_ID = 'test-square-app-id';
    process.env.SQUARE_APPLICATION_SECRET = 'test-square-app-secret';
    process.env.SQUARE_REDIRECT_URI = 'http://localhost:3001/integrations/square/callback';
    process.env.SQUARE_ENVIRONMENT = 'sandbox';
    process.env.POS_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-for-integrations-reconcile-test';

    app = buildServer({ logger: false });
    await app.ready();
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const orgId of createdOrgIds) {
      await db.delete(unmappedSales).where(eq(unmappedSales.organizationId, orgId));
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

  const setUpOrgWithStore = async (): Promise<{ organizationId: string; storeId: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Integrations Reconcile Test Org ${organizationId}`,
      slug: `integrations-reconcile-test-org-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const issueSession = async (organizationId: string, storeIds: string[] | 'ALL'): Promise<string> => {
    const { token } = await sessionStore.create(
      { userId: generateId(), organizationId, storeIds, role: 'OWNER', permissions: [] },
      '127.0.0.1',
      'test-agent'
    );
    return token;
  };

  const connectSquare = async (organizationId: string, storeId: string, externalLocationId = 'LOC-1'): Promise<void> => {
    await db.insert(posConnections).values({
      id: generateId(),
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: 'test-merchant',
      externalLocationId,
      accessTokenCiphertext: encryptToken('fake-access-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
      refreshTokenCiphertext: encryptToken('fake-refresh-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
      status: 'CONNECTED',
    });
  };

  const stubSquareOrdersResponse = (body: unknown): void => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v2/orders/search')) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch;
  };

  const oneCompletedOrder = (externalId: string, catalogObjectId = 'VAR-1') => ({
    orders: [
      {
        id: externalId,
        location_id: 'LOC-1',
        created_at: '2026-08-02T12:00:00Z',
        state: 'COMPLETED',
        line_items: [
          {
            uid: `${externalId}-LINE-1`,
            catalog_object_id: catalogObjectId,
            name: 'Cappuccino',
            quantity: '1',
            base_price_money: { amount: 450, currency: 'USD' },
            total_money: { amount: 450, currency: 'USD' },
          },
        ],
        total_money: { amount: 450, currency: 'USD' },
        total_tax_money: { amount: 36, currency: 'USD' },
        total_discount_money: { amount: 0, currency: 'USD' },
      },
    ],
  });

  it('rejects a request with no session cookie (401)', async () => {
    const { storeId } = await setUpOrgWithStore();
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.reconcileSquareOrders',
      payload: { storeId },
    });
    expect(response.statusCode).toBe(401);
  });

  it('a real DB lookup rejects a storeId from a different organization, even with storeIds ALL', async () => {
    const { storeId: otherOrgStoreId } = await setUpOrgWithStore();
    const { organizationId: myOrgId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(myOrgId, 'ALL');

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.reconcileSquareOrders',
      payload: { storeId: otherOrgStoreId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a store with no Square connection', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.reconcileSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(400);
  });

  it('finds and records an order the incremental sync watermark would never revisit', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    // Simulate an incremental sync that already ran to completion and advanced its watermark to
    // "now" — a missed webhook means the real order was never recorded, and a plain incremental
    // sync from this point forward would never look back far enough to find it.
    await db
      .update(posConnections)
      .set({ ordersSyncCursor: null, ordersSyncWatermark: new Date() })
      .where(eq(posConnections.organizationId, organizationId));

    stubSquareOrdersResponse(oneCompletedOrder('ORDER-MISSED-WEBHOOK'));

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.reconcileSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.transactionsRecorded).toBe(1);

    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(txRows).toHaveLength(1);
    expect(txRows[0]!.externalId).toBe('ORDER-MISSED-WEBHOOK');

    const outboxRows = await db.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.eventType).toBe('sales.ingested');
  });

  it('never advances ordersSyncCursor or ordersSyncWatermark, even after recording new orders', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const fixedWatermark = new Date('2026-07-01T00:00:00Z');
    await db
      .update(posConnections)
      .set({ ordersSyncCursor: 'stale-incremental-cursor', ordersSyncWatermark: fixedWatermark })
      .where(eq(posConnections.organizationId, organizationId));

    stubSquareOrdersResponse(oneCompletedOrder('ORDER-RECONCILED'));

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.reconcileSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data.transactionsRecorded).toBe(1);

    const connectionRows = await db.select().from(posConnections).where(eq(posConnections.organizationId, organizationId));
    // The incremental sync's own state must be exactly what it was before reconciliation ran —
    // untouched by the reconciliation sweep's own real writes to sales_transactions/outbox_events.
    expect(connectionRows[0]!.ordersSyncCursor).toBe('stale-incremental-cursor');
    expect(connectionRows[0]!.ordersSyncWatermark!.toISOString()).toBe(fixedWatermark.toISOString());
  });

  it('re-running reconciliation over the same window is idempotent — no duplicate row, no duplicate outbox event', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    stubSquareOrdersResponse(oneCompletedOrder('ORDER-RECONCILE-IDEMPOTENT'));
    const first = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.reconcileSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(JSON.parse(first.body).result.data.transactionsRecorded).toBe(1);

    stubSquareOrdersResponse(oneCompletedOrder('ORDER-RECONCILE-IDEMPOTENT'));
    const second = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.reconcileSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body).result.data;
    expect(secondBody.transactionsRecorded).toBe(0);
    expect(secondBody.transactionsDuplicate).toBe(1);

    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(txRows).toHaveLength(1);

    const outboxRows = await db.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    expect(outboxRows).toHaveLength(1);
  });

  it('detects a refund on an order only the earlier incremental sync had recorded', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    // The incremental sync recorded the order previously; reconciliation now re-fetches the same
    // window and sees the order carries a refund the incremental sync never saw (e.g. its webhook
    // for the refund itself was the one that got dropped).
    stubSquareOrdersResponse(oneCompletedOrder('ORDER-REFUND-RECONCILED'));
    const initialSync = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(JSON.parse(initialSync.body).result.data.transactionsRecorded).toBe(1);

    stubSquareOrdersResponse({
      orders: [
        {
          ...oneCompletedOrder('ORDER-REFUND-RECONCILED').orders[0],
          refunds: [{ amount_money: { amount: 450, currency: 'USD' }, status: 'APPROVED' }],
        },
      ],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.reconcileSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.transactionsDuplicate).toBe(1); // original order already existed
    expect(body.refundsProcessed).toBe(1);

    const refundRows = await db
      .select()
      .from(salesTransactions)
      .where(eq(salesTransactions.organizationId, organizationId));
    expect(refundRows).toHaveLength(2); // original + REFUNDED row
    const refundRow = refundRows.find((r) => r.status === 'REFUNDED');
    expect(refundRow).toBeDefined();
    // amount_money.amount is in cents (Square's own convention) — 450 cents = $4.50, matching the
    // original order's own total.
    expect(refundRow!.total).toBe('4.5000');
  });
});
