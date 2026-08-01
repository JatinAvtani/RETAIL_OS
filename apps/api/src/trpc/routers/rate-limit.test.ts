import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, hashPassword, memberships, organizations, users, verificationTokens } from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string; stack?: string } } };

const rpc = async (
  app: FastifyInstance,
  path: string,
  body: Record<string, unknown>,
  ip?: string
): Promise<{ status: number; body: TrpcSuccess | TrpcError }> => {
  // Fastify's inject() defaults every request to the same loopback address, which would make
  // every test in this file share one IP-scope counter unless overridden per test.
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    payload: body,
    ...(ip ? { remoteAddress: ip } : {}),
  });
  return { status: response.statusCode, body: response.json() as TrpcSuccess | TrpcError };
};

const asError = (body: TrpcSuccess | TrpcError): TrpcError['error'] => {
  if (!('error' in body)) {
    throw new Error(`Expected a tRPC error response, got success: ${JSON.stringify(body)}`);
  }
  return body.error;
};

const uniqueIp = () =>
  `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

/**
 * Real Postgres + real Redis, exercised through the genuine HTTP boundary — proves the actual
 * lockout behavior spec 14 §14.2 asks for ("rate limiting on auth endpoints: per IP, per account,
 * with progressive delay and lockout"), not just that `RateLimiter`'s unit tests pass in isolation.
 */
describe('rate limiting on auth endpoints', () => {
  let app: FastifyInstance;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];
  const usedIps: string[] = [];
  const usedEmails: string[] = [];

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
    for (const ip of usedIps) {
      await redis.del(`rate-limit:auth-ip:${ip}`);
    }
    for (const email of usedEmails) {
      await redis.del(`rate-limit:auth-account:${email.toLowerCase()}`);
    }
    createdUserIds.length = 0;
    createdOrgIds.length = 0;
    usedIps.length = 0;
    usedEmails.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const createRealUser = async (options: {
    email: string;
    password: string;
  }): Promise<{ userId: string; organizationId: string }> => {
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(options.password);

    await db.insert(users).values({
      id: userId,
      email: options.email,
      passwordHash,
      emailVerifiedAt: new Date(),
    });

    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Test Org ${organizationId}`,
      slug: `test-org-${organizationId}`,
      baseCurrency: 'USD',
    });
    await db.insert(memberships).values({
      id: generateId(),
      organizationId,
      userId,
      role: 'STAFF',
      acceptedAt: new Date(),
    });

    return { userId, organizationId };
  };

  it('locks out an account after 5 failed login attempts, even from different IPs', async () => {
    const email = uniqueEmail('lockout-account');
    usedEmails.push(email);
    await createRealUser({ email, password: 'the-real-password-123456' });

    for (let i = 0; i < 5; i++) {
      const ip = uniqueIp();
      usedIps.push(ip);
      const { status } = await rpc(app, 'auth.login', { email, password: 'wrong-password' }, ip);
      expect(status).toBe(401);
    }

    const ip = uniqueIp();
    usedIps.push(ip);
    const { status, body } = await rpc(
      app,
      'auth.login',
      { email, password: 'the-real-password-123456' },
      ip
    );

    expect(status).toBe(429);
    expect(asError(body).message).toBe('Too many attempts. Please try again later.');
  });

  it('locks out an IP after 20 failed login attempts against different accounts', async () => {
    const ip = uniqueIp();
    usedIps.push(ip);

    for (let i = 0; i < 20; i++) {
      const email = uniqueEmail(`lockout-ip-${i}`);
      const { status } = await rpc(app, 'auth.login', { email, password: 'wrong-password' }, ip);
      expect(status).toBe(401);
    }

    const { status, body } = await rpc(
      app,
      'auth.login',
      { email: uniqueEmail('lockout-ip-final'), password: 'wrong-password' },
      ip
    );

    expect(status).toBe(429);
    expect(asError(body).message).toBe('Too many attempts. Please try again later.');
  });

  it('a successful login resets the account counter, so failed attempts before it are forgotten', async () => {
    const email = uniqueEmail('reset-on-success');
    usedEmails.push(email);
    const password = 'the-real-password-123456';
    await createRealUser({ email, password });

    for (let i = 0; i < 4; i++) {
      const ip = uniqueIp();
      usedIps.push(ip);
      await rpc(app, 'auth.login', { email, password: 'wrong-password' }, ip);
    }

    const successIp = uniqueIp();
    usedIps.push(successIp);
    const { status: successStatus } = await rpc(app, 'auth.login', { email, password }, successIp);
    expect(successStatus).toBe(200);

    // 4 more failures after the reset should NOT trip the 5-attempt threshold, since the earlier
    // 4 were cleared by the successful login above.
    for (let i = 0; i < 4; i++) {
      const ip = uniqueIp();
      usedIps.push(ip);
      const { status } = await rpc(app, 'auth.login', { email, password: 'wrong-password' }, ip);
      expect(status).toBe(401);
    }
  });

  it('locks out signup attempts from one IP after 20 calls', async () => {
    // 20 real signups (each a real Argon2id hash + DB insert) genuinely take longer than the
    // default 5s test timeout - not a rate-limiter correctness issue.
    const ip = uniqueIp();
    usedIps.push(ip);

    for (let i = 0; i < 20; i++) {
      const email = uniqueEmail(`signup-lockout-${i}`);
      usedEmails.push(email);
      const { status } = await rpc(
        app,
        'auth.signup',
        { email, password: 'a-genuinely-long-password-123' },
        ip
      );
      expect(status).toBe(200);
    }

    const { status, body } = await rpc(
      app,
      'auth.signup',
      { email: uniqueEmail('signup-lockout-final'), password: 'a-genuinely-long-password-123' },
      ip
    );

    expect(status).toBe(429);
    expect(asError(body).message).toBe('Too many attempts. Please try again later.');
  }, 15000);

  it('a locked-out account cannot be unlocked by trying from a fresh IP', async () => {
    const email = uniqueEmail('lockout-persists');
    usedEmails.push(email);
    await createRealUser({ email, password: 'the-real-password-123456' });

    for (let i = 0; i < 5; i++) {
      const ip = uniqueIp();
      usedIps.push(ip);
      await rpc(app, 'auth.login', { email, password: 'wrong-password' }, ip);
    }

    const freshIp = uniqueIp();
    usedIps.push(freshIp);
    const { status } = await rpc(
      app,
      'auth.login',
      { email, password: 'the-real-password-123456' },
      freshIp
    );

    expect(status).toBe(429);
  });
});
