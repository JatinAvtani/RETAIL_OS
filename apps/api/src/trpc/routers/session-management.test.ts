import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, hashPassword, memberships, organizations, users, verificationTokens } from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string; stack?: string } } };

/** For tRPC mutations — POST. */
const rpc = async (
  app: FastifyInstance,
  path: string,
  body: Record<string, unknown> | undefined,
  cookie?: string
): Promise<{ status: number; body: TrpcSuccess | TrpcError; cookies: Record<string, string> }> => {
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    payload: body ?? {},
    ...(cookie !== undefined ? { headers: { cookie: `__Host-session=${cookie}` } } : {}),
  });
  const cookies: Record<string, string> = {};
  for (const c of response.cookies) {
    cookies[c.name] = c.value;
  }
  return { status: response.statusCode, body: response.json() as TrpcSuccess | TrpcError, cookies };
};

/** For tRPC queries (`auth.me`, `auth.listSessions`) — GET, matching the tRPC HTTP adapter's own method requirement; POSTing to a query returns 405, not the procedure's real response. */
const rpcQuery = async (
  app: FastifyInstance,
  path: string,
  cookie?: string
): Promise<{ status: number; body: TrpcSuccess | TrpcError }> => {
  const response = await app.inject({
    method: 'GET',
    url: `/trpc/${path}`,
    ...(cookie !== undefined ? { headers: { cookie: `__Host-session=${cookie}` } } : {}),
  });
  return { status: response.statusCode, body: response.json() as TrpcSuccess | TrpcError };
};

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

const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Real Postgres + real Redis, through the genuine HTTP boundary: proves `auth.listSessions`/
 * `auth.revokeSession` actually expose `SessionStore.listForUser`/`revoke` (already real,
 * already used internally for logout/password-reset) as user-triggered device-management actions —
 * a real backend capability that previously had no caller anywhere in the app.
 */
describe('auth.listSessions / auth.revokeSession', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
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

  const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const createRealUser = async (email: string, password: string): Promise<{ userId: string; organizationId: string }> => {
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });

    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Test Org ${organizationId}`, slug: `test-org-${organizationId}`, baseCurrency: 'USD' });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role: 'OWNER', acceptedAt: new Date() });

    return { userId, organizationId };
  };

  it('listSessions returns the real live session with isCurrent true, never the raw token', async () => {
    const email = uniqueEmail('list-sessions');
    const password = 'a-genuinely-long-password-123';
    await createRealUser(email, password);

    const loginResult = await rpc(app, 'auth.login', { email, password });
    const token = loginResult.cookies['__Host-session']!;

    const { status, body } = await rpcQuery(app, 'auth.listSessions', token);
    expect(status).toBe(200);
    const data = asSuccess(body);
    const sessions = data as unknown as Array<{ sessionHash: string; isCurrent: boolean; ip: string; userAgent: string }>;

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.isCurrent).toBe(true);
    expect(sessions[0]!.sessionHash).toBe(hashSessionToken(token));
    // The real Redis token must never appear anywhere in the response.
    expect(JSON.stringify(sessions)).not.toContain(token);
  });

  it('listSessions reports two real concurrent sessions for the same user, exactly one marked isCurrent', async () => {
    const email = uniqueEmail('list-sessions-two');
    const password = 'a-genuinely-long-password-123';
    await createRealUser(email, password);

    const firstLogin = await rpc(app, 'auth.login', { email, password });
    const secondLogin = await rpc(app, 'auth.login', { email, password });
    const firstToken = firstLogin.cookies['__Host-session']!;
    const secondToken = secondLogin.cookies['__Host-session']!;
    expect(firstToken).not.toBe(secondToken);

    const { body } = await rpcQuery(app, 'auth.listSessions', secondToken);
    const sessions = asSuccess(body) as unknown as Array<{ sessionHash: string; isCurrent: boolean }>;

    expect(sessions).toHaveLength(2);
    const currentOnes = sessions.filter((s) => s.isCurrent);
    expect(currentOnes).toHaveLength(1);
    expect(currentOnes[0]!.sessionHash).toBe(hashSessionToken(secondToken));
  });

  it('revokeSession on a DIFFERENT device logs that device out but leaves the caller logged in', async () => {
    const email = uniqueEmail('revoke-other');
    const password = 'a-genuinely-long-password-123';
    await createRealUser(email, password);

    const deviceA = await rpc(app, 'auth.login', { email, password });
    const deviceB = await rpc(app, 'auth.login', { email, password });
    const tokenA = deviceA.cookies['__Host-session']!;
    const tokenB = deviceB.cookies['__Host-session']!;

    const { body: listBody } = await rpcQuery(app, 'auth.listSessions', tokenA);
    const sessions = asSuccess(listBody) as unknown as Array<{ sessionHash: string; isCurrent: boolean }>;
    const deviceBSession = sessions.find((s) => !s.isCurrent)!;
    expect(deviceBSession.sessionHash).toBe(hashSessionToken(tokenB));

    const { status } = await rpc(app, 'auth.revokeSession', { sessionHash: deviceBSession.sessionHash }, tokenA);
    expect(status).toBe(200);

    // Device B's own session is genuinely gone from Redis.
    expect(await redis.get(`session:${tokenB}`)).toBeNull();
    // Device A (the caller) is still fully logged in — revoking one session must not touch others.
    const { status: meStatusA } = await rpcQuery(app, 'auth.me', tokenA);
    expect(meStatusA).toBe(200);
  });

  it('revoking the CALLER\'S OWN current session also clears their cookie', async () => {
    const email = uniqueEmail('revoke-self');
    const password = 'a-genuinely-long-password-123';
    await createRealUser(email, password);

    const login = await rpc(app, 'auth.login', { email, password });
    const token = login.cookies['__Host-session']!;
    const selfSessionId = hashSessionToken(token);

    const revokeResult = await rpc(app, 'auth.revokeSession', { sessionHash: selfSessionId }, token);
    expect(revokeResult.status).toBe(200);
    expect(revokeResult.cookies['__Host-session']).toBe('');

    expect(await redis.get(`session:${token}`)).toBeNull();
  });

  it('a client cannot revoke a session belonging to a DIFFERENT user by guessing its hash', async () => {
    const emailA = uniqueEmail('revoke-crosstenant-a');
    const emailB = uniqueEmail('revoke-crosstenant-b');
    const password = 'a-genuinely-long-password-123';
    await createRealUser(emailA, password);
    await createRealUser(emailB, password);

    const loginA = await rpc(app, 'auth.login', { email: emailA, password });
    const loginB = await rpc(app, 'auth.login', { email: emailB, password });
    const tokenA = loginA.cookies['__Host-session']!;
    const tokenB = loginB.cookies['__Host-session']!;

    // User A tries to revoke user B's real session by its real hash — must be a silent no-op
    // (never leaking whether the hash matched someone else's session), and B must remain logged in.
    const { status } = await rpc(app, 'auth.revokeSession', { sessionHash: hashSessionToken(tokenB) }, tokenA);
    expect(status).toBe(200);

    expect(await redis.get(`session:${tokenB}`)).not.toBeNull();
  });

  it('rejects an unauthenticated call to listSessions', async () => {
    const { status, body } = await rpcQuery(app, 'auth.listSessions');
    expect(status).toBe(401);
    expect(asError(body).message).toBe('Not signed in.');
  });
});
