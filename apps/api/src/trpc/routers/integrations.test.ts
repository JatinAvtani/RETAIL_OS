import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, organizations, posConnections, posItems, stores } from '@retailos/db';
import { encryptToken } from '@retailos/pos';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * 006-04: real HTTP verification for `integrations.syncSquareCatalog`. `global.fetch` is patched
 * (Square's own host only, real MinIO/Postgres/Redis calls untouched) — no live Square sandbox app
 * exists in this codebase yet, same standing limitation `square-routes.test.ts` already documented
 * for OAuth, but this router's happy path genuinely needs a real Square response shape to prove the
 * upsert + delist logic end to end, not just an unreachable-network error path.
 */
describe('integrations.syncSquareCatalog', () => {
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
    process.env.POS_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-for-integrations-test';

    app = buildServer({ logger: false });
    await app.ready();
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const orgId of createdOrgIds) {
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
      name: `Integrations Test Org ${organizationId}`,
      slug: `integrations-test-org-${organizationId}`,
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

  const connectSquare = async (organizationId: string, storeId: string): Promise<void> => {
    await db.insert(posConnections).values({
      id: generateId(),
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: 'test-merchant',
      accessTokenCiphertext: encryptToken('fake-access-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
      refreshTokenCiphertext: encryptToken('fake-refresh-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
      status: 'CONNECTED',
    });
  };

  const stubSquareCatalogResponse = (body: unknown): void => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v2/catalog/search-catalog-objects')) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch;
  };

  it('rejects a request with no session cookie (401)', async () => {
    const { storeId } = await setUpOrgWithStore();
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareCatalog',
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
      url: '/trpc/integrations.syncSquareCatalog',
      payload: { storeId: otherOrgStoreId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a store with no Square connection, distinct from a cross-tenant rejection', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareCatalog',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(400);
  });

  it('a genuinely connected store syncs a real catalog page into pos_items as UNMAPPED', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    stubSquareCatalogResponse({
      objects: [
        {
          id: 'ITEM-SYNC-1',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Cappuccino',
            variations: [
              {
                id: 'VAR-SYNC-1',
                type: 'ITEM_VARIATION',
                item_variation_data: {
                  name: 'Regular',
                  sku: 'CAPP-1',
                  pricing_type: 'FIXED_PRICING',
                  price_money: { amount: 450, currency: 'USD' },
                },
              },
            ],
          },
        },
      ],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareCatalog',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.variationsUpserted).toBe(1);
    expect(body.itemsDelisted).toBe(0);

    const rows = await db.select().from(posItems).where(eq(posItems.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalId).toBe('VAR-SYNC-1');
    expect(rows[0]!.mappingStatus).toBe('UNMAPPED');
    expect(rows[0]!.price).toBe('4.5000');
  });

  it('an item present in a prior sync but absent from the next is marked delisted, not deleted', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    stubSquareCatalogResponse({
      objects: [
        {
          id: 'ITEM-GONE',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Soon Gone',
            variations: [
              {
                id: 'VAR-GONE',
                type: 'ITEM_VARIATION',
                item_variation_data: { name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 300, currency: 'USD' } },
              },
            ],
          },
        },
      ],
    });
    const first = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareCatalog',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(first.statusCode).toBe(200);

    // Second sync's catalog no longer includes VAR-GONE at all.
    await new Promise((resolve) => setTimeout(resolve, 10));
    stubSquareCatalogResponse({ objects: [] });
    const second = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareCatalog',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body).result.data;
    expect(secondBody.itemsDelisted).toBe(1);

    const rows = await db.select().from(posItems).where(eq(posItems.organizationId, organizationId));
    expect(rows).toHaveLength(1); // marked, not deleted
    expect(rows[0]!.delistedAt).not.toBeNull();
  });

  it('re-running the sync with the same catalog is idempotent — no duplicate rows', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const catalogBody = {
      objects: [
        {
          id: 'ITEM-IDEMPOTENT',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Muffin',
            variations: [
              {
                id: 'VAR-IDEMPOTENT',
                type: 'ITEM_VARIATION',
                item_variation_data: { name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 250, currency: 'USD' } },
              },
            ],
          },
        },
      ],
    };

    for (let i = 0; i < 2; i++) {
      stubSquareCatalogResponse(catalogBody);
      const response = await app.inject({
        method: 'POST',
        url: '/trpc/integrations.syncSquareCatalog',
        payload: { storeId },
        cookies: { '__Host-session': sessionCookie },
      });
      expect(response.statusCode).toBe(200);
    }

    const rows = await db.select().from(posItems).where(eq(posItems.organizationId, organizationId));
    expect(rows).toHaveLength(1);
  });
});
