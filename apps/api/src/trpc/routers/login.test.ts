import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  hashPassword,
  memberships,
  organizations,
  users,
  verificationTokens,
} from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string; stack?: string } } };

const rpc = async (
  app: FastifyInstance,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: TrpcSuccess | TrpcError; cookies: Record<string, string> }> => {
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    payload: body,
  });
  const cookies: Record<string, string> = {};
  for (const cookie of response.cookies) {
    cookies[cookie.name] = cookie.value;
  }
  return { status: response.statusCode, body: response.json() as TrpcSuccess | TrpcError, cookies };
};

const asError = (body: TrpcSuccess | TrpcError): TrpcError['error'] => {
  if (!('error' in body)) {
    throw new Error(`Expected a tRPC error response, got success: ${JSON.stringify(body)}`);
  }
  return body.error;
};

/**
 * Real Postgres + real Redis: proves the actual login flow, not a mocked SessionStore or a
 * hand-called procedure — password verification, email-verification gating, membership lookup
 * via the RLS-bypassing SECURITY DEFINER function, session creation, and cookie attributes are
 * all exercised through the genuine HTTP boundary.
 */
describe('auth.login', () => {
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
      await db.delete(verificationTokens).where(eq(verificationTokens.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    for (const orgId of createdOrgIds) {
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

  /** Creates a verified user, optionally with one accepted membership, bypassing signup/verify. */
  const createRealUser = async (options: {
    email: string;
    password: string;
    verified?: boolean;
    membership?: { role: 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER_FINANCE'; accepted?: boolean };
  }): Promise<{ userId: string; organizationId?: string }> => {
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(options.password);

    await db.insert(users).values({
      id: userId,
      email: options.email,
      passwordHash,
      emailVerifiedAt: options.verified === false ? null : new Date(),
    });

    if (!options.membership) {
      return { userId };
    }

    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Test Org ${organizationId.slice(0, 8)}`,
      slug: `test-org-${organizationId.slice(0, 8)}`,
      baseCurrency: 'USD',
    });
    await db.insert(memberships).values({
      id: generateId(),
      organizationId,
      userId,
      role: options.membership.role,
      acceptedAt: options.membership.accepted === false ? null : new Date(),
    });

    return { userId, organizationId };
  };

  it('logs in successfully with correct credentials and an accepted membership', async () => {
    const email = uniqueEmail('login-ok');
    const password = 'a-genuinely-long-password-123';
    const { organizationId } = await createRealUser({
      email,
      password,
      membership: { role: 'MANAGER' },
    });

    const { status, cookies } = await rpc(app, 'auth.login', { email, password });

    expect(status).toBe(200);
    expect(cookies['__Host-session']).toBeDefined();

    const raw = await redis.get(`session:${cookies['__Host-session']}`);
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw!);
    expect(record.organizationId).toBe(organizationId);
    expect(record.role).toBe('MANAGER');
    expect(record.permissions).toContain('inventory:write');
  });

  it('sets the cookie with __Host- prefix, HttpOnly, Secure, and SameSite=Lax', async () => {
    const email = uniqueEmail('login-cookie');
    const password = 'a-genuinely-long-password-123';
    await createRealUser({ email, password, membership: { role: 'OWNER' } });

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password },
    });

    const setCookieHeader = response.headers['set-cookie'];
    const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    expect(header).toContain('__Host-session=');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
  });

  it('rejects a wrong password with a generic 401, no cookie set', async () => {
    const email = uniqueEmail('login-wrongpw');
    await createRealUser({
      email,
      password: 'the-real-password-123456',
      membership: { role: 'STAFF' },
    });

    const { status, body, cookies } = await rpc(app, 'auth.login', {
      email,
      password: 'a-completely-different-password',
    });

    expect(status).toBe(401);
    expect(asError(body).message).toBe('Invalid credentials.');
    expect(cookies['__Host-session']).toBeUndefined();
  });

  it('rejects a nonexistent email with the identical generic error (no enumeration)', async () => {
    const { status, body } = await rpc(app, 'auth.login', {
      email: 'this-email-was-never-registered@example.test',
      password: 'any-password-at-all-123',
    });

    expect(status).toBe(401);
    expect(asError(body).message).toBe('Invalid credentials.');
  });

  it('blocks login for an unverified email with a specific 403', async () => {
    const email = uniqueEmail('login-unverified');
    const password = 'a-genuinely-long-password-123';
    await createRealUser({ email, password, verified: false, membership: { role: 'OWNER' } });

    const { status, body } = await rpc(app, 'auth.login', { email, password });

    expect(status).toBe(403);
    expect(asError(body).message).toBe('Please verify your email before logging in.');
  });

  it('rejects login for a verified user with no accepted membership (generic, same as bad credentials)', async () => {
    const email = uniqueEmail('login-nomembership');
    const password = 'a-genuinely-long-password-123';
    await createRealUser({ email, password });

    const { status, body } = await rpc(app, 'auth.login', { email, password });

    expect(status).toBe(401);
    expect(asError(body).message).toBe('Invalid credentials.');
  });

  it('rejects login for a membership that has not been accepted yet (pending invite)', async () => {
    const email = uniqueEmail('login-pending');
    const password = 'a-genuinely-long-password-123';
    await createRealUser({
      email,
      password,
      membership: { role: 'STAFF', accepted: false },
    });

    const { status, body } = await rpc(app, 'auth.login', { email, password });

    expect(status).toBe(401);
    expect(asError(body).message).toBe('Invalid credentials.');
  });

  it('rejects login for a user with more than one accepted membership, explicitly', async () => {
    const email = uniqueEmail('login-multiorg');
    const password = 'a-genuinely-long-password-123';
    const { userId } = await createRealUser({
      email,
      password,
      membership: { role: 'OWNER' },
    });

    const secondOrgId = generateId();
    createdOrgIds.push(secondOrgId);
    await db.insert(organizations).values({
      id: secondOrgId,
      name: `Second Org ${secondOrgId.slice(0, 8)}`,
      slug: `second-org-${secondOrgId.slice(0, 8)}`,
      baseCurrency: 'USD',
    });
    await db.insert(memberships).values({
      id: generateId(),
      organizationId: secondOrgId,
      userId,
      role: 'MANAGER',
      acceptedAt: new Date(),
    });

    const { status, body } = await rpc(app, 'auth.login', { email, password });

    expect(status).toBe(501);
    expect(asError(body).message).toBe('Accounts with multiple organizations are not yet supported at login.');
  });
});

describe('auth.logout', () => {
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
      await db.delete(verificationTokens).where(eq(verificationTokens.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    for (const orgId of createdOrgIds) {
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

  const loginRealUser = async (): Promise<{ userId: string; sessionToken: string }> => {
    const email = uniqueEmail('logout');
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);

    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });

    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Test Org ${organizationId.slice(0, 8)}`,
      slug: `test-org-${organizationId.slice(0, 8)}`,
      baseCurrency: 'USD',
    });
    await db.insert(memberships).values({
      id: generateId(),
      organizationId,
      userId,
      role: 'STAFF',
      acceptedAt: new Date(),
    });

    const { cookies } = await rpc(app, 'auth.login', { email, password });
    return { userId, sessionToken: cookies['__Host-session']! };
  };

  it('revokes a real session and clears the cookie', async () => {
    const { userId, sessionToken } = await loginRealUser();

    expect(await redis.get(`session:${sessionToken}`)).not.toBeNull();

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.logout',
      payload: {},
      cookies: { '__Host-session': sessionToken },
    });

    expect(response.statusCode).toBe(200);
    expect(asSuccess(response.json())).toEqual({ message: 'Logged out.' });

    const setCookieHeader = response.headers['set-cookie'];
    const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    expect(header).toContain('__Host-session=;');

    expect(await redis.get(`session:${sessionToken}`)).toBeNull();
    expect(await redis.smembers(`user-sessions:${userId}`)).not.toContain(sessionToken);
  });

  it('is idempotent: logging out twice with the same (now-revoked) cookie still succeeds', async () => {
    const { sessionToken } = await loginRealUser();

    const first = await app.inject({
      method: 'POST',
      url: '/trpc/auth.logout',
      payload: {},
      cookies: { '__Host-session': sessionToken },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/trpc/auth.logout',
      payload: {},
      cookies: { '__Host-session': sessionToken },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it('succeeds with no session cookie at all — nothing to reveal to a caller who was never logged in', async () => {
    const response = await app.inject({ method: 'POST', url: '/trpc/auth.logout', payload: {} });

    expect(response.statusCode).toBe(200);
    expect(asSuccess(response.json())).toEqual({ message: 'Logged out.' });
  });

  it("does not revoke a different user's session", async () => {
    const { sessionToken: victimToken } = await loginRealUser();

    await app.inject({
      method: 'POST',
      url: '/trpc/auth.logout',
      payload: {},
      cookies: { '__Host-session': 'a-token-that-was-never-issued' },
    });

    expect(await redis.get(`session:${victimToken}`)).not.toBeNull();
  });
});

const asSuccess = (body: TrpcSuccess | TrpcError): TrpcSuccess['result']['data'] => {
  if (!('result' in body)) {
    throw new Error(`Expected a successful tRPC response, got an error: ${JSON.stringify(body)}`);
  }
  return body.result.data;
};
