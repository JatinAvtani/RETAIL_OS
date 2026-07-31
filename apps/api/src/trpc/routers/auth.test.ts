import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, users, verificationTokens } from '@retailos/db';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * Exercises the real Fastify + tRPC HTTP pipeline via `inject()` (in-process, no real socket, but
 * a genuine request/response cycle through Fastify's router and the tRPC adapter) against the
 * real Postgres database — not a mocked repository or a hand-called procedure function. This is
 * what actually proves signup/verification work end-to-end, which unit tests on UserRepository
 * alone (packages/db) cannot: they don't exercise error-code mapping, input validation wiring, or
 * the enumeration-safety behavior at the HTTP boundary.
 */
type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string; stack?: string } } };

const rpc = async (
  app: FastifyInstance,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: TrpcSuccess | TrpcError }> => {
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    payload: body,
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

describe('auth router', () => {
  let app: FastifyInstance;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const createdEmails: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const email of createdEmails) {
      const rows = await db.select().from(users).where(eq(users.email, email));
      for (const user of rows) {
        await db.delete(verificationTokens).where(eq(verificationTokens.userId, user.id));
      }
      await db.delete(users).where(eq(users.email, email));
    }
    createdEmails.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  it('signup creates a user and returns a verification token', async () => {
    const email = uniqueEmail('signup');
    createdEmails.push(email);

    const { status, body } = await rpc(app, 'auth.signup', {
      email,
      password: 'a-genuinely-long-password-123',
    });

    expect(status).toBe(200);
    const data = asSuccess(body);
    expect(data.message).toBe('Check your email to verify your account.');
    expect(typeof data._devOnlyVerificationToken).toBe('string');
  });

  it('signup with an already-registered email returns the identical response shape (no enumeration)', async () => {
    const email = uniqueEmail('dupe');
    createdEmails.push(email);

    await rpc(app, 'auth.signup', { email, password: 'a-genuinely-long-password-123' });
    const { status, body } = await rpc(app, 'auth.signup', {
      email,
      password: 'a-totally-different-password-456',
    });

    expect(status).toBe(200);
    const data = asSuccess(body);
    expect(data.message).toBe('Check your email to verify your account.');
    expect(data._devOnlyVerificationToken).toBeUndefined();
  });

  it('signup rejects a password that fails policy with 400, not 500, and no stack trace', async () => {
    const { status, body } = await rpc(app, 'auth.signup', {
      email: uniqueEmail('badpw'),
      password: 'short',
    });

    expect(status).toBe(400);
    const error = asError(body);
    expect(error.data.code).toBe('BAD_REQUEST');
    expect(error.data.stack).toBeUndefined();
  });

  it('signup rejects a malformed email with 400', async () => {
    const { status, body } = await rpc(app, 'auth.signup', {
      email: 'not-an-email',
      password: 'a-genuinely-long-password-123',
    });

    expect(status).toBe(400);
    expect(asError(body).data.code).toBe('BAD_REQUEST');
  });

  it('verifyEmail with a real token marks the user verified', async () => {
    const email = uniqueEmail('verify');
    createdEmails.push(email);

    const signupResult = await rpc(app, 'auth.signup', {
      email,
      password: 'a-genuinely-long-password-123',
    });
    const token = asSuccess(signupResult.body)._devOnlyVerificationToken;

    const { status, body } = await rpc(app, 'auth.verifyEmail', { token });

    expect(status).toBe(200);
    expect(asSuccess(body).message).toBe('Email verified.');

    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it('verifyEmail rejects an unrecognized token with 400 and a generic message', async () => {
    const { status, body } = await rpc(app, 'auth.verifyEmail', {
      token: 'this-token-was-never-issued',
    });

    expect(status).toBe(400);
    const error = asError(body);
    expect(error.data.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('This verification link is invalid or has expired.');
  });

  it('verifyEmail rejects a token that has already been consumed', async () => {
    const email = uniqueEmail('reuse');
    createdEmails.push(email);

    const signupResult = await rpc(app, 'auth.signup', {
      email,
      password: 'a-genuinely-long-password-123',
    });
    const token = asSuccess(signupResult.body)._devOnlyVerificationToken;

    const first = await rpc(app, 'auth.verifyEmail', { token });
    const second = await rpc(app, 'auth.verifyEmail', { token });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
  });
});
