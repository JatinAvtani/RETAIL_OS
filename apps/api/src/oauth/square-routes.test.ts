import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, organizations, posConnections, stores } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../server';
import type { FastifyInstance } from 'fastify';

/**
 * Covers everything that doesn't require a live Square OAuth exchange (no way to automate
 * completing Square's real consent screen). Proves: the connect route requires a real session
 * (unlike Google login's anonymous flow, Square Connect happens to an already-authenticated
 * owner/manager); a session cannot connect a store outside its own org OR outside its own
 * `storeIds` scope, even with `storeIds: 'ALL'` (a real DB lookup, not just `canAccessStore`); the
 * CSRF state round-trips storeId correctly; every callback error path before the real Square
 * network call.
 */
describe('Square OAuth routes', () => {
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
    process.env.POS_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-for-square-routes-test';

    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
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
      name: `Square Test Org ${organizationId}`,
      slug: `square-test-org-${organizationId}`,
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

  it('GET /integrations/square/connect rejects an unauthenticated request', async () => {
    const { storeId } = await setUpOrgWithStore();
    const response = await app.inject({ method: 'GET', url: `/integrations/square/connect?storeId=${storeId}` });
    expect(response.statusCode).toBe(401);
  });

  it('GET /integrations/square/connect requires a storeId', async () => {
    const { organizationId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, 'ALL');
    const response = await app.inject({
      method: 'GET',
      url: '/integrations/square/connect',
      cookies: { '__Host-session': sessionCookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('GET /integrations/square/connect with storeIds ALL redirects to Square for a real store in the caller own org', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: `/integrations/square/connect?storeId=${storeId}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin).toBe('https://connect.squareupsandbox.com');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('storeIds ALL does not let a session connect a DIFFERENT org real store — a real DB lookup catches it, not just canAccessStore', async () => {
    const { storeId: otherOrgStoreId } = await setUpOrgWithStore();
    const { organizationId: myOrgId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(myOrgId, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: `/integrations/square/connect?storeId=${otherOrgStoreId}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('a session explicitly scoped to OTHER stores cannot connect a store it is not scoped to, even within the same org', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, [generateId()]); // scoped to some other store, not `storeId`

    const response = await app.inject({
      method: 'GET',
      url: `/integrations/square/connect?storeId=${storeId}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('callback redirects with an error when Square reports one (consent declined)', async () => {
    const { organizationId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: '/integrations/square/callback?error=access_denied',
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('error=square_oauth_denied');
  });

  it('callback redirects to a not-signed-in error when no session cookie is present, before ever looking at Square error/state params', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/integrations/square/callback?error=access_denied',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('error=square_not_signed_in');
  });

  it('callback rejects a request with no state', async () => {
    const { organizationId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: '/integrations/square/callback?code=some-code',
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('error=square_invalid_state');
  });

  it('callback rejects a state that was never issued (forged or already consumed)', async () => {
    const { organizationId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const response = await app.inject({
      method: 'GET',
      url: '/integrations/square/callback?code=some-code&state=forged-nonce:some-store-id',
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('error=square_invalid_state');
  });

  it('a real, freshly-issued state can only be consumed once — replaying the callback fails the second time', async () => {
    const { organizationId, storeId } = await setUpOrgWithStore();
    const sessionCookie = await issueSession(organizationId, 'ALL');

    const authorize = await app.inject({
      method: 'GET',
      url: `/integrations/square/connect?storeId=${storeId}`,
      cookies: { '__Host-session': sessionCookie },
    });
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;

    const first = await app.inject({
      method: 'GET',
      url: `/integrations/square/callback?code=an-invalid-test-code&state=${state}`,
      cookies: { '__Host-session': sessionCookie },
    });
    const second = await app.inject({
      method: 'GET',
      url: `/integrations/square/callback?code=an-invalid-test-code&state=${state}`,
      cookies: { '__Host-session': sessionCookie },
    });

    // First call consumes the state and fails at the real Square network call (no live Square to
    // talk to in a test) — proving the state itself isn't why it failed.
    expect(first.headers.location).toContain('error=square_token_exchange_failed');
    // Second call reuses an already-consumed state — the property under test.
    expect(second.headers.location).toContain('error=square_invalid_state');
  });

  it('a state whose storeId the CURRENT session cannot access is rejected in the callback too, not just the connect step', async () => {
    const { storeId: storeIdA, organizationId: orgA } = await setUpOrgWithStore();
    const { organizationId: orgB } = await setUpOrgWithStore();

    // Issue state legitimately as a session scoped to org A's store...
    const sessionA = await issueSession(orgA, 'ALL');
    const authorize = await app.inject({
      method: 'GET',
      url: `/integrations/square/connect?storeId=${storeIdA}`,
      cookies: { '__Host-session': sessionA },
    });
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;

    // ...then replay the callback under a DIFFERENT session (org B) presenting the same state.
    const sessionB = await issueSession(orgB, 'ALL');
    const response = await app.inject({
      method: 'GET',
      url: `/integrations/square/callback?code=some-code&state=${state}`,
      cookies: { '__Host-session': sessionB },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('error=square_store_not_found');
  });
});
