import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, menuItems, organizations, posItems, salesTransactionLines, salesTransactions, stores } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * unmapped POS items ranked by sales volume,
 * fuzzy-suggested against real menu items, mapped or ignored only on a human's real HTTP request
 * (I9) — no automatic mapping path exists anywhere in this router.
 */
describe('posItems', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sessionStore = new SessionStore(redis);
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await db.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await db.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await db.delete(posItems).where(eq(posItems.organizationId, orgId));
      await db.delete(menuItems).where(eq(menuItems.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const setUpOrgWithStore = async (): Promise<{ organizationId: string; storeId: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Pos Items Test Org ${organizationId}`,
      slug: `pos-items-test-org-${organizationId}`,
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

  describe('listUnmapped', () => {
    it('rejects a request with no session cookie (401)', async () => {
      const { storeId } = await setUpOrgWithStore();
      const response = await app.inject({
        method: 'GET',
        url: `/trpc/posItems.listUnmapped?input=${encodeURIComponent(JSON.stringify({ storeId }))}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns unmapped items ranked by revenue, each with fuzzy-suggested menu item matches', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();

      const cappuccinoId = generateId();
      const muffinId = generateId();
      await db.insert(posItems).values([
        { id: cappuccinoId, organizationId, storeId, source: 'square', externalId: 'SQ-1', name: 'Cappuccino', mappingStatus: 'UNMAPPED' },
        { id: muffinId, organizationId, storeId, source: 'square', externalId: 'SQ-2', name: 'Blueberry Muffin', mappingStatus: 'UNMAPPED' },
      ]);
      const menuItemId = generateId();
      await db.insert(menuItems).values({
        id: menuItemId,
        organizationId,
        name: 'Cappuccino',
        recipeGroupId: generateId(),
        price: '4.5000',
        priceValidFrom: new Date('2026-01-01T00:00:00Z'),
      });

      const transactionId = generateId();
      await db.insert(salesTransactions).values({
        id: transactionId,
        organizationId,
        storeId,
        source: 'square',
        externalId: 'SQ-ORDER-1',
        occurredAt: new Date(),
        subtotal: '50.0000',
        discount: '0.0000',
        tax: '0.0000',
        total: '50.0000',
        currency: 'USD',
      });
      await db.insert(salesTransactionLines).values({
        id: generateId(),
        organizationId,
        transactionId,
        posItemId: cappuccinoId,
        quantity: '10.000000',
        unitPrice: '5.0000',
        discount: '0.0000',
        lineTotal: '50.0000',
      });

      const sessionCookie = await issueSession(organizationId, 'ALL');
      const response = await app.inject({
        method: 'GET',
        url: `/trpc/posItems.listUnmapped?input=${encodeURIComponent(JSON.stringify({ storeId }))}`,
        cookies: { '__Host-session': sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data as Array<{
        id: string;
        name: string;
        totalRevenue: string;
        suggestions: Array<{ menuItemId: string; name: string; score: number }>;
      }>;
      expect(body).toHaveLength(2);
      // Higher-revenue item ranks first.
      expect(body[0]!.id).toBe(cappuccinoId);
      expect(body[0]!.totalRevenue).toBe('50.0000');
      expect(body[0]!.suggestions[0]).toEqual({ menuItemId, name: 'Cappuccino', score: 1 });
      // Never-sold item still appears, ranked last, with no genuine menu-item match.
      expect(body[1]!.id).toBe(muffinId);
      expect(body[1]!.totalRevenue).toBe('0');
      expect(body[1]!.suggestions).toEqual([]);
    });

    it('a real store lookup means tenant B cannot list tenant A\'s unmapped items via tenant A\'s storeId (404)', async () => {
      const { organizationId: orgA, storeId: storeA } = await setUpOrgWithStore();
      const { organizationId: orgB } = await setUpOrgWithStore();
      await db.insert(posItems).values({
        id: generateId(),
        organizationId: orgA,
        storeId: storeA,
        source: 'square',
        externalId: 'SQ-CROSS-1',
        name: 'Tenant A Item',
        mappingStatus: 'UNMAPPED',
      });
      const sessionCookieB = await issueSession(orgB, 'ALL');

      const response = await app.inject({
        method: 'GET',
        url: `/trpc/posItems.listUnmapped?input=${encodeURIComponent(JSON.stringify({ storeId: storeA }))}`,
        cookies: { '__Host-session': sessionCookieB },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('mapToMenuItem', () => {
    it('a human confirming a mapping sets menuItemId and flips status to MAPPED', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      const posItemId = generateId();
      await db.insert(posItems).values({
        id: posItemId,
        organizationId,
        storeId,
        source: 'csv',
        externalId: 'CSV-1',
        name: 'House Salad',
        mappingStatus: 'UNMAPPED',
      });
      const menuItemId = generateId();
      await db.insert(menuItems).values({
        id: menuItemId,
        organizationId,
        name: 'House Salad',
        recipeGroupId: generateId(),
        price: '9.0000',
        priceValidFrom: new Date('2026-01-01T00:00:00Z'),
      });
      const sessionCookie = await issueSession(organizationId, 'ALL');

      const response = await app.inject({
        method: 'POST',
        url: '/trpc/posItems.mapToMenuItem',
        cookies: { '__Host-session': sessionCookie },
        payload: { id: posItemId, menuItemId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data as { mappingStatus: string; menuItemId: string };
      expect(body.mappingStatus).toBe('MAPPED');
      expect(body.menuItemId).toBe(menuItemId);
    });

    it('rejects mapping to a menu item that does not exist (404)', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      const posItemId = generateId();
      await db.insert(posItems).values({
        id: posItemId,
        organizationId,
        storeId,
        source: 'csv',
        externalId: 'CSV-2',
        name: 'Unknown Item',
        mappingStatus: 'UNMAPPED',
      });
      const sessionCookie = await issueSession(organizationId, 'ALL');

      const response = await app.inject({
        method: 'POST',
        url: '/trpc/posItems.mapToMenuItem',
        cookies: { '__Host-session': sessionCookie },
        payload: { id: posItemId, menuItemId: generateId() },
      });

      expect(response.statusCode).toBe(404);
    });

    it('tenant B cannot map tenant A\'s pos item by id (404)', async () => {
      const { organizationId: orgA, storeId: storeA } = await setUpOrgWithStore();
      const { organizationId: orgB } = await setUpOrgWithStore();
      const posItemId = generateId();
      await db.insert(posItems).values({
        id: posItemId,
        organizationId: orgA,
        storeId: storeA,
        source: 'square',
        externalId: 'SQ-CROSS-2',
        name: 'Tenant A Item',
        mappingStatus: 'UNMAPPED',
      });
      const menuItemIdB = generateId();
      await db.insert(menuItems).values({
        id: menuItemIdB,
        organizationId: orgB,
        name: 'Tenant B Menu Item',
        recipeGroupId: generateId(),
        price: '5.0000',
        priceValidFrom: new Date('2026-01-01T00:00:00Z'),
      });
      const sessionCookieB = await issueSession(orgB, 'ALL');

      const response = await app.inject({
        method: 'POST',
        url: '/trpc/posItems.mapToMenuItem',
        cookies: { '__Host-session': sessionCookieB },
        payload: { id: posItemId, menuItemId: menuItemIdB },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('ignore', () => {
    it('flips a genuinely non-menu item (e.g. a gift card) to IGNORED', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      const posItemId = generateId();
      await db.insert(posItems).values({
        id: posItemId,
        organizationId,
        storeId,
        source: 'square',
        externalId: 'SQ-GIFT',
        name: 'Gift Card',
        mappingStatus: 'UNMAPPED',
      });
      const sessionCookie = await issueSession(organizationId, 'ALL');

      const response = await app.inject({
        method: 'POST',
        url: '/trpc/posItems.ignore',
        cookies: { '__Host-session': sessionCookie },
        payload: { id: posItemId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data as { mappingStatus: string; menuItemId: string | null };
      expect(body.mappingStatus).toBe('IGNORED');
      expect(body.menuItemId).toBeNull();
    });

    it('tenant B cannot ignore tenant A\'s pos item by id (404)', async () => {
      const { organizationId: orgA, storeId: storeA } = await setUpOrgWithStore();
      const { organizationId: orgB } = await setUpOrgWithStore();
      const posItemId = generateId();
      await db.insert(posItems).values({
        id: posItemId,
        organizationId: orgA,
        storeId: storeA,
        source: 'square',
        externalId: 'SQ-CROSS-3',
        name: 'Tenant A Item',
        mappingStatus: 'UNMAPPED',
      });
      const sessionCookieB = await issueSession(orgB, 'ALL');

      const response = await app.inject({
        method: 'POST',
        url: '/trpc/posItems.ignore',
        cookies: { '__Host-session': sessionCookieB },
        payload: { id: posItemId },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
