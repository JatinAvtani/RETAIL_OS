import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, memberships, organizations, stores, users, verificationTokens } from '@retailos/db';
import type { FastifyInstance } from 'fastify';

/**
 * `auth.demoLogin` reads its target email from `process.env.DEMO_ACCOUNT_EMAIL` at MODULE LOAD
 * time (see `auth.ts`'s own doc comment on `DEMO_ACCOUNT_EMAIL`) — this file's own tests run
 * against the same real database as local dev (no separate TEST_DATABASE_URL for apps/api), so
 * this suite sets a genuinely unique, throwaway email BEFORE importing `buildServer`, via a
 * dynamic import after `process.env` is set, rather than ever seeding/deleting a row at the
 * literal `demo@vyapaar.test` address the real product uses.
 */
const testDemoEmail = `demo-login-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
process.env.DEMO_ACCOUNT_EMAIL = testDemoEmail;

const { buildServer } = await import('../../server');

type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string } } };

const rpc = async (app: FastifyInstance, path: string, body: Record<string, unknown>) => {
  const response = await app.inject({ method: 'POST', url: `/trpc/${path}`, payload: body });
  return { status: response.statusCode, body: response.json() as TrpcSuccess | TrpcError };
};

const asSuccess = (body: TrpcSuccess | TrpcError): TrpcSuccess['result']['data'] => {
  if (!('result' in body)) throw new Error(`Expected success, got error: ${JSON.stringify(body)}`);
  return body.result.data;
};

describe('auth.demoLogin', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    const rows = await db.select().from(users).where(eq(users.email, testDemoEmail));
    for (const user of rows) {
      await db.delete(verificationTokens).where(eq(verificationTokens.userId, user.id));
      const userMemberships = await db.select().from(memberships).where(eq(memberships.userId, user.id));
      for (const membership of userMemberships) {
        await db.delete(memberships).where(eq(memberships.id, membership.id));
        await db.delete(stores).where(eq(stores.organizationId, membership.organizationId));
        await db.delete(organizations).where(eq(organizations.id, membership.organizationId));
      }
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns SERVICE_UNAVAILABLE when no demo account exists at all — never a raw 500 or a leaked internal error', async () => {
    const { status, body } = await rpc(app, 'auth.demoLogin', {});
    expect(status).toBe(503);
    expect('error' in body).toBe(true);
  });

  it('a real, verified demo account with exactly one accepted membership gets a real session and a real cookie', async () => {
    const signup = await rpc(app, 'auth.signup', {
      email: testDemoEmail,
      password: 'a-genuinely-long-password-123',
      organizationName: 'Test Demo Bakehouse',
      storeName: 'Main Store',
      storeTimezone: 'America/New_York',
      baseCurrency: 'USD',
    });
    const token = asSuccess(signup.body)._devOnlyVerificationToken as string;
    await rpc(app, 'auth.verifyEmail', { token });

    const response = await app.inject({ method: 'POST', url: '/trpc/auth.demoLogin', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data.message).toBe('Logged in.');
    expect(response.cookies.some((c) => c.name === '__Host-session')).toBe(true);
  });

  it('accepts a genuinely empty request body — no email/password input schema at all, unlike auth.login', async () => {
    // The whole point of a dedicated endpoint: nothing about the demo account's real password
    // ever needs to exist in a client request, unlike a hardcoded-credentials login call. An empty
    // body reaching a real 503 (no demo account exists in this test's isolated env, by design)
    // rather than a 400 zod-validation error proves the procedure takes no input at all.
    const { status } = await rpc(app, 'auth.demoLogin', {});
    expect(status).toBe(503);
  });
});
