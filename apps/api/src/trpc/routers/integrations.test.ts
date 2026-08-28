import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, organizations, posConnections, stores } from '@retailos/db';
import { encryptToken } from '@retailos/pos';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import { squareSyncQueue } from '../context';
import type { FastifyInstance } from 'fastify';

/**
 * real HTTP verification for `integrations.syncSquareCatalog`. The router no longer runs the
 * sync itself — it does precondition checks and enqueues a real BullMQ job onto `squareSyncQueue`,
 * returning `{ enqueued: true }` immediately. The real sync RESULT (variationsUpserted,
 * itemsDelisted, real pos_items writes, idempotency, etc.) is now proven directly against
 * `syncSquareCatalog` in `packages/integrations/src/square-catalog-sync.test.ts` — this file's
 * scope shrank to what the router genuinely still does: auth, tenant isolation, precondition
 * rejections, and a real assertion that a successful call actually enqueues the right job.
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

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      const jobs = await squareSyncQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
      for (const job of jobs) {
        if (job.data.organizationId === orgId) {
          await job.remove();
        }
      }
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

  it('a genuinely connected store enqueues a real catalog sync job and returns immediately', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await connectSquare(organizationId, storeId);
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const countsBefore = await squareSyncQueue.getJobCounts();
    const totalBefore = Object.values(countsBefore).reduce((a, b) => a + b, 0);

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareCatalog',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body).toEqual({ enqueued: true });

    const countsAfter = await squareSyncQueue.getJobCounts();
    const totalAfter = Object.values(countsAfter).reduce((a, b) => a + b, 0);
    expect(totalAfter).toBe(totalBefore + 1);

    const jobs = await squareSyncQueue.getJobs(['waiting', 'delayed', 'active']);
    const ourJob = jobs.find((job) => job.data.organizationId === organizationId && job.data.storeId === storeId);
    expect(ourJob).toBeDefined();
    expect(ourJob!.data.kind).toBe('catalog');
    expect(ourJob!.name).toBe('catalog');
  });
});
