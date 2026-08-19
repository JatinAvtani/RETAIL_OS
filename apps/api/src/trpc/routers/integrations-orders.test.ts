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
 * real HTTP verification for `integrations.syncSquareOrders`. `global.fetch` is patched
 * (Square's own host only) — no live Square sandbox app exists yet, same standing limitation as
 * earlier work's catalog sync. This file specifically proves the plan's named top risk: the cursor and
 * watermark only advance together with the order/line writes they gate, inside one transaction, and
 * a re-synced (overlapping) window is genuinely idempotent — no double-counted revenue.
 */
describe('integrations.syncSquareOrders', () => {
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
    process.env.POS_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-for-integrations-orders-test';

    app = buildServer({ logger: false });
    await app.ready();
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const orgId of createdOrgIds) {
      // syncSquareOrders now genuinely triggers consumption for each recorded line
      // — unmapped_sales (a real menu-item quarantine) and stock_movements/stock_levels/lots (a
      // real FEFO consumption) are all real write paths now, not hypothetical ones, and each needs
      // its own cleanup before stores/organizations can be deleted.
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
      name: `Integrations Orders Test Org ${organizationId}`,
      slug: `integrations-orders-test-org-${organizationId}`,
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
      url: '/trpc/integrations.syncSquareOrders',
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
      url: '/trpc/integrations.syncSquareOrders',
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
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a connection with no linked externalLocationId', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId, undefined as unknown as string);
    await db.update(posConnections).set({ externalLocationId: null }).where(eq(posConnections.organizationId, organizationId));
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(400);
  });

  it('a genuinely connected store syncs a real order into sales_transactions + lines + an outbox event, all in one commit', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    await db.insert(posItems).values({
      id: generateId(),
      organizationId,
      storeId,
      source: 'square',
      externalId: 'VAR-1',
      name: 'Cappuccino',
      mappingStatus: 'UNMAPPED',
    });
    const sessionCookie = await issueSession(organizationId, 'ALL');

    stubSquareOrdersResponse(oneCompletedOrder('ORDER-SYNC-1'));

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.transactionsRecorded).toBe(1);
    expect(body.transactionsDuplicate).toBe(0);

    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(txRows).toHaveLength(1);
    expect(txRows[0]!.externalId).toBe('ORDER-SYNC-1');
    expect(txRows[0]!.status).toBe('COMPLETED');
    expect(txRows[0]!.total).toBe('4.5000');

    const lineRows = await db.select().from(salesTransactionLines).where(eq(salesTransactionLines.organizationId, organizationId));
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0]!.posItemId).not.toBeNull(); // resolved via catalog_object_id -> pos_items.external_id

    const outboxRows = await db.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.eventType).toBe('sales.ingested');

    const connectionRows = await db.select().from(posConnections).where(eq(posConnections.organizationId, organizationId));
    expect(connectionRows[0]!.ordersSyncWatermark).not.toBeNull();
  });

  it('a line whose catalog_object_id has no matching pos_items row still records the transaction, with posItemId null', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    stubSquareOrdersResponse(oneCompletedOrder('ORDER-UNKNOWN-ITEM', 'VAR-NEVER-SYNCED'));

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const lineRows = await db.select().from(salesTransactionLines).where(eq(salesTransactionLines.organizationId, organizationId));
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0]!.posItemId).toBeNull();
  });

  it('re-syncing the same order (an overlapping window) is idempotent — recorded once, counted duplicate the second time', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    stubSquareOrdersResponse(oneCompletedOrder('ORDER-IDEMPOTENT'));
    const first = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(JSON.parse(first.body).result.data.transactionsRecorded).toBe(1);

    stubSquareOrdersResponse(oneCompletedOrder('ORDER-IDEMPOTENT'));
    const second = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body).result.data;
    expect(secondBody.transactionsRecorded).toBe(0);
    expect(secondBody.transactionsDuplicate).toBe(1);

    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(txRows).toHaveLength(1); // no duplicate row, no double-counted revenue

    const outboxRows = await db.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    expect(outboxRows).toHaveLength(1); // no duplicate event for the duplicate sync
  });

  it('a CANCELED order maps to sales_transactions.status VOIDED', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    stubSquareOrdersResponse({
      orders: [
        {
          id: 'ORDER-CANCELED',
          location_id: 'LOC-1',
          created_at: '2026-08-02T12:00:00Z',
          state: 'CANCELED',
          line_items: [],
          total_money: { amount: 0, currency: 'USD' },
        },
      ],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(txRows[0]!.status).toBe('VOIDED');
  });
});
