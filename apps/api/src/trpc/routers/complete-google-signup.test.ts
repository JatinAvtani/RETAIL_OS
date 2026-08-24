import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, memberships, organizations, stores, users, UserRepository } from '@retailos/db';
import { buildServer } from '../../server';
import { createProvisioningSession, SESSION_COOKIE_NAME } from '../../auth/establish-session';
import { sessionStore } from '../context';
import type { FastifyInstance } from 'fastify';

/**
 * Covers the second half of a Google sign-up: `auth.completeGoogleSignup`.
 *
 * The flow exists because Google authenticates a person but cannot describe their business, so a
 * first-time Google sign-in used to create a `users` row, find no workspace for it, and bounce the
 * person to /login — leaving an orphaned account that owned their email address, could never sign
 * in, and blocked them from signing up properly. These tests pin both that the flow now completes
 * AND the two authorization boundaries that keep it from becoming a way to mint workspaces.
 *
 * The real Google exchange cannot be driven from a test (it needs Google), so these start from the
 * provisioning session the callback issues — `createProvisioningSession`, the same function the
 * route calls — rather than mocking the procedure under test.
 */
type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string } } };

const rpc = async (
  app: FastifyInstance,
  path: string,
  body: Record<string, unknown>,
  sessionToken?: string
): Promise<{ status: number; body: TrpcSuccess | TrpcError; setCookie: string[] }> => {
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    payload: body,
    ...(sessionToken ? { cookies: { [SESSION_COOKIE_NAME]: sessionToken } } : {}),
  });
  const raw = response.headers['set-cookie'];
  return {
    status: response.statusCode,
    body: response.json() as TrpcSuccess | TrpcError,
    setCookie: raw === undefined ? [] : Array.isArray(raw) ? raw : [raw],
  };
};

/** `auth.me` is a tRPC query, so it is a GET — POSTing to it returns 405, not the auth error. */
const rpcQuery = async (
  app: FastifyInstance,
  path: string,
  sessionToken: string
): Promise<{ status: number; body: TrpcSuccess | TrpcError }> => {
  const response = await app.inject({
    method: 'GET',
    url: `/trpc/${path}`,
    cookies: { [SESSION_COOKIE_NAME]: sessionToken },
  });
  return { status: response.statusCode, body: response.json() as TrpcSuccess | TrpcError };
};

const asError = (body: TrpcSuccess | TrpcError): TrpcError['error'] => {
  if (!('error' in body)) {
    throw new Error(`Expected a tRPC error response, got success: ${JSON.stringify(body)}`);
  }
  return body.error;
};

describe('auth.completeGoogleSignup', () => {
  let app: FastifyInstance;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const createdEmails: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  // FK order matters: memberships -> stores -> organizations -> users. Getting this wrong is the
  // single most repeated teardown bug in this project's history.
  afterEach(async () => {
    for (const email of createdEmails) {
      const rows = await db.select().from(users).where(eq(users.email, email));
      for (const user of rows) {
        const userMemberships = await db.select().from(memberships).where(eq(memberships.userId, user.id));
        for (const membership of userMemberships) {
          await db.delete(memberships).where(eq(memberships.id, membership.id));
          await db.delete(stores).where(eq(stores.organizationId, membership.organizationId));
          await db.delete(organizations).where(eq(organizations.id, membership.organizationId));
        }
      }
      await db.delete(users).where(eq(users.email, email));
    }
    createdEmails.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  /** A user in exactly the state the OAuth callback leaves them: real, verified, no workspace. */
  const createGoogleUserWithProvisioningSession = async (email: string) => {
    const userRepository = new UserRepository(db);
    const userId = await userRepository.createFromGoogle(email, `google-${Math.random().toString(36).slice(2)}`, 'Test User');
    const token = await createProvisioningSession(sessionStore, userId, '127.0.0.1', 'vitest');
    return { userId, token };
  };

  const workspace = {
    organizationName: 'Shanthi Coffee House',
    storeName: 'Koramangala',
    storeTimezone: 'Asia/Kolkata',
    baseCurrency: 'INR',
  };

  it('creates the workspace and makes the account genuinely usable', async () => {
    const email = uniqueEmail('google-complete');
    createdEmails.push(email);
    const { userId, token } = await createGoogleUserWithProvisioningSession(email);

    const { status, setCookie } = await rpc(app, 'auth.completeGoogleSignup', workspace, token);
    expect(status).toBe(200);

    // The org, store and OWNER membership all exist...
    const created = await db.select().from(memberships).where(eq(memberships.userId, userId));
    expect(created).toHaveLength(1);
    expect(created[0]!.role).toBe('OWNER');
    expect(created[0]!.acceptedAt).not.toBeNull();

    const org = await db.select().from(organizations).where(eq(organizations.id, created[0]!.organizationId));
    expect(org[0]!.name).toBe(workspace.organizationName);
    expect(org[0]!.baseCurrency).toBe('INR');

    // ...and the response replaced the provisioning cookie with a real session. Without this swap
    // the user would own a working workspace they still could not open — the dead end this whole
    // flow exists to remove.
    expect(setCookie.join(';')).toContain(SESSION_COOKIE_NAME);
  });

  it('issues a session that can actually reach a protected procedure', async () => {
    const email = uniqueEmail('google-usable');
    createdEmails.push(email);
    const { token } = await createGoogleUserWithProvisioningSession(email);

    // Before: the provisioning session is barred from every tenant-scoped procedure.
    const before = await rpcQuery(app, 'auth.me', token);
    expect(before.status).toBe(403);
    expect(asError(before.body).message).toBe('Finish setting up your workspace first.');

    const { setCookie } = await rpc(app, 'auth.completeGoogleSignup', workspace, token);
    const upgraded = /(?:^|;\s*)__Host-session=([^;]+)/.exec(setCookie.join('; '))?.[1];
    expect(upgraded).toBeDefined();

    // After: the same person, now holding a real session, gets through.
    const after = await rpcQuery(app, 'auth.me', upgraded!);
    expect(after.status).toBe(200);
  });

  it('revokes the provisioning session so it cannot be reused', async () => {
    const email = uniqueEmail('google-revoke');
    createdEmails.push(email);
    const { token } = await createGoogleUserWithProvisioningSession(email);

    await rpc(app, 'auth.completeGoogleSignup', workspace, token);

    // Replaying the old token must not create a second workspace.
    const replay = await rpc(app, 'auth.completeGoogleSignup', workspace, token);
    expect(replay.status).toBe(401);
  });

  it('refuses a user who already has a workspace (no minting a second one)', async () => {
    const email = uniqueEmail('google-second');
    createdEmails.push(email);
    const { token } = await createGoogleUserWithProvisioningSession(email);

    const first = await rpc(app, 'auth.completeGoogleSignup', workspace, token);
    const upgraded = /(?:^|;\s*)__Host-session=([^;]+)/.exec(first.setCookie.join('; '))?.[1];

    const second = await rpc(app, 'auth.completeGoogleSignup', { ...workspace, organizationName: 'Second Org' }, upgraded!);
    expect(second.status).toBe(403);
    expect(asError(second.body).message).toBe('This account already has a workspace.');
  });

  it('refuses an unauthenticated caller', async () => {
    const { status } = await rpc(app, 'auth.completeGoogleSignup', workspace);
    expect(status).toBe(401);
  });

  /**
   * The escape hatch. This page bars every other route via `protectedProcedure`, so if logout did
   * not accept a provisioning session there would be no way off it at all — the cookie survives a
   * tab close, so "just leave" does not work either. Pinned because `logout` being a
   * publicProcedure is what makes it work, and a future tightening to protectedProcedure would
   * silently re-trap exactly this user.
   */
  it('lets a provisioning session sign out, and revokes it', async () => {
    const email = uniqueEmail('google-signout');
    createdEmails.push(email);
    const { token } = await createGoogleUserWithProvisioningSession(email);

    const { status } = await rpc(app, 'auth.logout', {}, token);
    expect(status).toBe(200);

    // The token is genuinely dead afterwards, not merely cleared from the browser.
    const afterLogout = await rpc(app, 'auth.completeGoogleSignup', workspace, token);
    expect(afterLogout.status).toBe(401);
  });
});
