import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  hashPassword,
  memberships,
  organizations,
  stores,
  users,
} from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string } } };

const asSuccess = (body: TrpcSuccess | TrpcError): TrpcSuccess['result']['data'] => {
  if (!('result' in body)) {
    throw new Error(`Expected a successful tRPC response, got an error: ${JSON.stringify(body)}`);
  }
  return body.result.data;
};

const asError = (body: TrpcSuccess | TrpcError): TrpcError['error'] => {
  if (!('error' in body)) {
    throw new Error(`Expected a tRPC error response, got success: ${JSON.stringify(body)}`);
  }
  return body.error;
};

/**
 * Real Postgres + real Redis + real HTTP: proves object-level store scoping (the design rule
 * 2, task earlier work) — a Manager restricted to one store in `memberships.store_ids` genuinely cannot
 * see or fetch another store in the SAME org, and gets a 404, not a 403 (spec: a 403 confirms the
 * resource exists, which is an enumeration leak). This is a distinct check from tenant isolation
 * (a different org entirely, already covered by StoreRepository's own cross-tenant suite) — here
 * both stores belong to the same org, so RLS alone would let the query through; only the new
 * `canAccessStore` check in the router stops it.
 */
describe('stores router — object-level store scoping', () => {
  let app: FastifyInstance;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      const tokens = await redis.smembers(`user-sessions:${userId}`);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => `session:${t}`), `user-sessions:${userId}`);
      }
      await db.delete(memberships).where(eq(memberships.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    for (const orgId of createdOrgIds) {
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdUserIds.length = 0;
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const uniqueEmail = (label: string) =>
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  /**
   * One org, two real stores, and a real logged-in user whose membership is scoped to only one of
   * them (or 'ALL' if `storeIds` is omitted) — returns the session cookie from a real login, not a
   * hand-built session, so the whole resolution chain (password → membership → session → cookie)
   * is exercised, not just the object-level check in isolation.
   */
  const setUpOrgWithTwoStores = async (options: {
    role: 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER_FINANCE';
    scopedToFirstStoreOnly: boolean;
  }): Promise<{ storeIdA: string; storeIdB: string; sessionCookie: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Test Org ${organizationId}`,
      slug: `test-org-${organizationId}`,
      baseCurrency: 'USD',
    });

    const storeIdA = generateId();
    const storeIdB = generateId();
    await db.insert(stores).values([
      { id: storeIdA, organizationId, name: 'Store A', timezone: 'America/New_York' },
      { id: storeIdB, organizationId, name: 'Store B', timezone: 'America/New_York' },
    ]);

    const email = uniqueEmail('stores-scoping');
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });

    await db.insert(memberships).values({
      id: generateId(),
      organizationId,
      userId,
      role: options.role,
      storeIds: options.scopedToFirstStoreOnly ? [storeIdA] : null,
      acceptedAt: new Date(),
    });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password },
    });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    return { storeIdA, storeIdB, sessionCookie };
  };

  it('a store-scoped Manager can fetch the store they are scoped to', async () => {
    const { storeIdA, sessionCookie } = await setUpOrgWithTwoStores({
      role: 'MANAGER',
      scopedToFirstStoreOnly: true,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/stores.get?input=${encodeURIComponent(JSON.stringify({ id: storeIdA }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect((asSuccess(response.json()) as { name: string }).name).toBe('Store A');
  });

  it('a store-scoped Manager gets 404 (not 403) fetching a different store in their OWN org', async () => {
    const { storeIdB, sessionCookie } = await setUpOrgWithTwoStores({
      role: 'MANAGER',
      scopedToFirstStoreOnly: true,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/stores.get?input=${encodeURIComponent(JSON.stringify({ id: storeIdB }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(asError(response.json()).message).toBe('Store not found.');
  });

  it('a store-scoped Manager\'s stores.list only includes their own store, not the other one in the same org', async () => {
    const { storeIdA, storeIdB, sessionCookie } = await setUpOrgWithTwoStores({
      role: 'MANAGER',
      scopedToFirstStoreOnly: true,
    });

    const response = await app.inject({
      method: 'GET',
      url: 'trpc/stores.list',
      cookies: { '__Host-session': sessionCookie },
    });

    const list = asSuccess(response.json()) as unknown as Array<{ id: string }>;
    expect(list.map((s) => s.id)).toContain(storeIdA);
    expect(list.map((s) => s.id)).not.toContain(storeIdB);
  });

  it('an org-wide Owner (storeIds null → ALL) can fetch both stores in their org', async () => {
    const { storeIdA, storeIdB, sessionCookie } = await setUpOrgWithTwoStores({
      role: 'OWNER',
      scopedToFirstStoreOnly: false,
    });

    const responseA = await app.inject({
      method: 'GET',
      url: `/trpc/stores.get?input=${encodeURIComponent(JSON.stringify({ id: storeIdA }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    const responseB = await app.inject({
      method: 'GET',
      url: `/trpc/stores.get?input=${encodeURIComponent(JSON.stringify({ id: storeIdB }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(responseA.statusCode).toBe(200);
    expect(responseB.statusCode).toBe(200);
  });

  it('an org-wide Owner\'s stores.list includes both stores in their org', async () => {
    const { storeIdA, storeIdB, sessionCookie } = await setUpOrgWithTwoStores({
      role: 'OWNER',
      scopedToFirstStoreOnly: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: 'trpc/stores.list',
      cookies: { '__Host-session': sessionCookie },
    });

    const list = asSuccess(response.json()) as unknown as Array<{ id: string }>;
    expect(list.map((s) => s.id)).toContain(storeIdA);
    expect(list.map((s) => s.id)).toContain(storeIdB);
  });

  it('fetching a nonexistent store id returns the identical 404 shape as a wrong-scope one', async () => {
    const { sessionCookie } = await setUpOrgWithTwoStores({
      role: 'OWNER',
      scopedToFirstStoreOnly: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/stores.get?input=${encodeURIComponent(JSON.stringify({ id: generateId() }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(asError(response.json()).message).toBe('Store not found.');
  });

  it('rejects an unauthenticated request with 401, not a store list', async () => {
    const response = await app.inject({ method: 'GET', url: 'trpc/stores.list' });

    expect(response.statusCode).toBe(401);
  });
});
