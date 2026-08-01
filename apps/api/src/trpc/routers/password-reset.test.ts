import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, hashPassword, verifyPassword, users, verificationTokens } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string } } };

const rpc = async (
  app: FastifyInstance,
  path: string,
  body: Record<string, unknown>,
  ip?: string
): Promise<{ status: number; body: TrpcSuccess | TrpcError; cookies: Record<string, string> }> => {
  // Fastify's inject() defaults every request to the same loopback address, which would make this
  // whole file share one IP-scope rate-limit counter across many tests unless overridden per call
  // (requestPasswordReset's rate limit is a real one, not a placeholder — see auth/rate-limit.ts).
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    payload: body,
    ...(ip ? { remoteAddress: ip } : {}),
  });
  const cookies: Record<string, string> = {};
  for (const cookie of response.cookies) {
    cookies[cookie.name] = cookie.value;
  }
  return { status: response.statusCode, body: response.json() as TrpcSuccess | TrpcError, cookies };
};

const uniqueIp = () =>
  `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

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
 * Real Postgres + real Redis + real HTTP: proves the password-reset flow end to end, including
 * the enumeration-safety of `requestPasswordReset` and that `resetPassword` genuinely revokes
 * every existing session for the account, not just accepts a new password for future logins.
 */
describe('password reset', () => {
  let app: FastifyInstance;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];

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
      await db.delete(verificationTokens).where(eq(verificationTokens.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const uniqueEmail = (label: string) =>
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const createRealUser = async (options: {
    email: string;
    password?: string;
    verified?: boolean;
  }): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = options.password ? await hashPassword(options.password) : null;

    await db.insert(users).values({
      id: userId,
      email: options.email,
      passwordHash,
      emailVerifiedAt: options.verified === false ? null : new Date(),
    });

    return userId;
  };

  it('requestPasswordReset returns a token for a real account with a password', async () => {
    const email = uniqueEmail('reset-request');
    await createRealUser({ email, password: 'the-original-password-123' });

    const { status, body } = await rpc(app, 'auth.requestPasswordReset', { email }, uniqueIp());

    expect(status).toBe(200);
    const data = asSuccess(body);
    expect(data.message).toBe('If an account exists for that email, a password reset link has been sent.');
    expect(typeof data._devOnlyPasswordResetToken).toBe('string');
  });

  it('requestPasswordReset returns the identical response with no token for a nonexistent email (no enumeration)', async () => {
    const { status, body } = await rpc(
      app,
      'auth.requestPasswordReset',
      { email: 'this-email-was-never-registered@example.test' },
      uniqueIp()
    );

    expect(status).toBe(200);
    const data = asSuccess(body);
    expect(data.message).toBe('If an account exists for that email, a password reset link has been sent.');
    expect(data._devOnlyPasswordResetToken).toBeUndefined();
  });

  it('requestPasswordReset returns the identical response with no token for an OAuth-only account (no password to reset)', async () => {
    const email = uniqueEmail('reset-oauth-only');
    await createRealUser({ email });

    const { status, body } = await rpc(app, 'auth.requestPasswordReset', { email }, uniqueIp());

    expect(status).toBe(200);
    const data = asSuccess(body);
    expect(data.message).toBe('If an account exists for that email, a password reset link has been sent.');
    expect(data._devOnlyPasswordResetToken).toBeUndefined();
  });

  it('resetPassword writes a new password hash that verifies the new password and rejects the old one', async () => {
    const email = uniqueEmail('reset-success');
    await createRealUser({ email, password: 'the-original-password-123' });

    const requestResult = await rpc(app, 'auth.requestPasswordReset', { email }, uniqueIp());
    const token = asSuccess(requestResult.body)._devOnlyPasswordResetToken as string;

    const { status, body } = await rpc(app, 'auth.resetPassword', {
      token,
      newPassword: 'the-brand-new-password-456',
    });

    expect(status).toBe(200);
    expect(asSuccess(body).message).toBe('Password has been reset.');

    const storedHash = (await db.select().from(users).where(eq(users.email, email)))[0]?.passwordHash;
    expect(storedHash).not.toBeNull();
    expect(await verifyPassword(storedHash!, 'the-brand-new-password-456')).toBe(true);
    expect(await verifyPassword(storedHash!, 'the-original-password-123')).toBe(false);
  });

  it('resetPassword revokes every existing session for the account', async () => {
    const email = uniqueEmail('reset-revokes-sessions');
    const userId = await createRealUser({ email, password: 'the-original-password-123' });

    // Create a real session directly (bypassing the "needs a membership" requirement of a real
    // login) to prove revocation specifically, independent of establishSessionForUser's own rules.
    const sessionStore = new SessionStore(redis);
    const { token: sessionToken } = await sessionStore.create(
      { userId, organizationId: 'org-1', storeIds: 'ALL', role: 'OWNER', permissions: ['financial:read'] },
      '127.0.0.1',
      'test-agent'
    );
    expect(await sessionStore.get(sessionToken)).not.toBeNull();

    const requestResult = await rpc(app, 'auth.requestPasswordReset', { email }, uniqueIp());
    const resetToken = asSuccess(requestResult.body)._devOnlyPasswordResetToken as string;

    await rpc(app, 'auth.resetPassword', { token: resetToken, newPassword: 'the-brand-new-password-456' });

    expect(await sessionStore.get(sessionToken)).toBeNull();
  });

  it('resetPassword rejects an unrecognized token with a generic 400', async () => {
    const { status, body } = await rpc(app, 'auth.resetPassword', {
      token: 'this-token-was-never-issued',
      newPassword: 'a-brand-new-password-123',
    });

    expect(status).toBe(400);
    const error = asError(body);
    expect(error.data.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('This password reset link is invalid or has expired.');
  });

  it('resetPassword rejects a token that has already been consumed', async () => {
    const email = uniqueEmail('reset-reuse');
    await createRealUser({ email, password: 'the-original-password-123' });

    const requestResult = await rpc(app, 'auth.requestPasswordReset', { email }, uniqueIp());
    const token = asSuccess(requestResult.body)._devOnlyPasswordResetToken as string;

    const first = await rpc(app, 'auth.resetPassword', { token, newPassword: 'first-new-password-123' });
    const second = await rpc(app, 'auth.resetPassword', { token, newPassword: 'second-new-password-456' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
  });

  it('resetPassword rejects a new password that fails policy, without consuming the token', async () => {
    const email = uniqueEmail('reset-badpw');
    await createRealUser({ email, password: 'the-original-password-123' });

    const requestResult = await rpc(app, 'auth.requestPasswordReset', { email }, uniqueIp());
    const token = asSuccess(requestResult.body)._devOnlyPasswordResetToken as string;

    const rejected = await rpc(app, 'auth.resetPassword', { token, newPassword: 'short' });
    expect(rejected.status).toBe(400);
    expect(asError(rejected.body).data.code).toBe('BAD_REQUEST');

    // The token must still be usable, since the policy-violating attempt never consumed it.
    const succeeded = await rpc(app, 'auth.resetPassword', {
      token,
      newPassword: 'a-perfectly-valid-new-password-123',
    });
    expect(succeeded.status).toBe(200);
  });
});
