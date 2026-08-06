import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, organizations, posConnections, posItems, stores, unmappedSales } from '@retailos/db';
import { encryptToken } from '@retailos/pos';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * 006-13 (spec 13 §13.4): real HTTP verification for `integrations.health` — every connection's
 * status, `data_freshness_lag`, and data-completeness counts (unmapped POS items, quarantined
 * sales), assembled by the registered `computeIntegrationHealthSummary` metric function
 * (`@retailos/metrics`), never computed ad hoc in this router.
 */
describe('integrations.health', () => {
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
      await db.delete(unmappedSales).where(eq(unmappedSales.organizationId, orgId));
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
  });

  const setUpOrgWithStore = async (): Promise<{ organizationId: string; storeId: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Integrations Health Test Org ${organizationId}`,
      slug: `integrations-health-test-org-${organizationId}`,
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

  it('rejects a request with no session cookie (401)', async () => {
    const response = await app.inject({ method: 'GET', url: '/trpc/integrations.health' });
    expect(response.statusCode).toBe(401);
  });

  it('returns an empty array for an org with no connections', async () => {
    const { organizationId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: '/trpc/integrations.health',
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('a healthy CONNECTED connection reports status, freshness, and zero counts', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    const connectionId = generateId();
    await db.insert(posConnections).values({
      id: connectionId,
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: 'merchant-1',
      accessTokenCiphertext: encryptToken('token', process.env.POS_TOKEN_ENCRYPTION_KEY ?? 'test-key'),
      status: 'CONNECTED',
      lastSuccessfulSyncAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
    });
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: '/trpc/integrations.health',
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data as Array<{
      connectionId: string;
      status: string;
      freshness: { status: string; lagMinutes?: number };
      unmappedItemCount: number;
      quarantineCount: number;
      error: unknown;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.connectionId).toBe(connectionId);
    expect(body[0]!.status).toBe('CONNECTED');
    expect(body[0]!.freshness.status).toBe('known');
    expect(body[0]!.freshness.lagMinutes).toBeGreaterThanOrEqual(9);
    expect(body[0]!.freshness.lagMinutes).toBeLessThanOrEqual(11);
    expect(body[0]!.unmappedItemCount).toBe(0);
    expect(body[0]!.quarantineCount).toBe(0);
    expect(body[0]!.error).toBeNull();
  });

  it('an EXPIRED connection reports a real plain-language error with a fix action, and a connection that never synced reports never_synced', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await db.insert(posConnections).values({
      id: generateId(),
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: 'merchant-2',
      accessTokenCiphertext: encryptToken('token', process.env.POS_TOKEN_ENCRYPTION_KEY ?? 'test-key'),
      status: 'EXPIRED',
      lastError: 'refresh_token_expired',
      lastSuccessfulSyncAt: null,
    });
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: '/trpc/integrations.health',
      cookies: { '__Host-session': sessionCookie },
    });

    const body = JSON.parse(response.body).result.data as Array<{
      status: string;
      freshness: { status: string };
      error: { message: string; fixAction: string } | null;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.status).toBe('EXPIRED');
    expect(body[0]!.freshness).toEqual({ status: 'never_synced' });
    expect(body[0]!.error).toEqual({ message: 'Your authorization expired.', fixAction: 'Reconnect Square' });
  });

  it('reports real unmapped pos_items and quarantined unmapped_sales counts, scoped to the connection\'s own store', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    await db.insert(posConnections).values({
      id: generateId(),
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: 'merchant-3',
      accessTokenCiphertext: encryptToken('token', process.env.POS_TOKEN_ENCRYPTION_KEY ?? 'test-key'),
      status: 'CONNECTED',
      lastSuccessfulSyncAt: new Date(),
    });
    await db.insert(posItems).values([
      { id: generateId(), organizationId, storeId, source: 'square', externalId: 'VAR-1', name: 'Latte', mappingStatus: 'UNMAPPED' },
      { id: generateId(), organizationId, storeId, source: 'square', externalId: 'VAR-2', name: 'Mocha', mappingStatus: 'UNMAPPED' },
      { id: generateId(), organizationId, storeId, source: 'square', externalId: 'VAR-3', name: 'Drip', mappingStatus: 'MAPPED' },
    ]);
    await db.insert(unmappedSales).values({
      id: generateId(),
      organizationId,
      storeId,
      posItemExternalId: 'VAR-1',
      posItemName: 'Latte',
      quantitySold: '1.000000',
      revenue: '4.5000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: '/trpc/integrations.health',
      cookies: { '__Host-session': sessionCookie },
    });

    const body = JSON.parse(response.body).result.data as Array<{ unmappedItemCount: number; quarantineCount: number }>;
    expect(body[0]!.unmappedItemCount).toBe(2); // only the two UNMAPPED rows, not the MAPPED one
    expect(body[0]!.quarantineCount).toBe(1);
  });

  it('a real DB lookup means one org\'s connections never appear in another org\'s health response', async () => {
    const { organizationId: orgA, storeId: storeA } = await setUpOrgWithStore();
    const { organizationId: orgB } = await setUpOrgWithStore();
    await db.insert(posConnections).values({
      id: generateId(),
      organizationId: orgA,
      storeId: storeA,
      vendor: 'square',
      externalAccountId: 'merchant-a',
      accessTokenCiphertext: encryptToken('token', process.env.POS_TOKEN_ENCRYPTION_KEY ?? 'test-key'),
      status: 'CONNECTED',
    });
    const sessionCookieB = await issueSession(orgB, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: '/trpc/integrations.health',
      cookies: { '__Host-session': sessionCookieB },
    });

    expect(JSON.parse(response.body).result.data).toEqual([]);
  });
});
