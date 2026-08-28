import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  hashPassword,
  invitations,
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
  body: Record<string, unknown>,
  cookie?: string
): Promise<{ status: number; body: TrpcSuccess | TrpcError; cookies: Record<string, string> }> => {
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    payload: body,
    ...(cookie ? { headers: { cookie: `__Host-session=${cookie}` } } : {}),
  });
  const cookies: Record<string, string> = {};
  for (const c of response.cookies) cookies[c.name] = c.value;
  return { status: response.statusCode, body: response.json() as TrpcSuccess | TrpcError, cookies };
};

/** A `.query()` procedure (unlike `.mutation()`) is called over GET with `?input=`, matching
 * tRPC's Fastify adapter — see assistant.test.ts's own established pattern for this same shape. */
const queryRpc = async (
  app: FastifyInstance,
  path: string,
  input: Record<string, unknown>,
  cookie?: string
): Promise<{ status: number; body: TrpcSuccess | TrpcError }> => {
  const response = await app.inject({
    method: 'GET',
    url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
    ...(cookie ? { headers: { cookie: `__Host-session=${cookie}` } } : {}),
  });
  return { status: response.statusCode, body: response.json() as TrpcSuccess | TrpcError };
};

const asSuccess = (body: TrpcSuccess | TrpcError): TrpcSuccess['result']['data'] => {
  if (!('result' in body)) throw new Error(`Expected success, got error: ${JSON.stringify(body)}`);
  return body.result.data;
};

const asError = (body: TrpcSuccess | TrpcError): TrpcError['error'] => {
  if (!('error' in body)) throw new Error(`Expected error, got success: ${JSON.stringify(body)}`);
  return body.error;
};

/**
 * Real Postgres + real Redis, real login-issued session cookies (via auth.login, not a hand-built
 * SessionRecord) — proves the protectedProcedure middleware, the users:manage gate, and the
 * account-mismatch guard all actually work through the genuine HTTP boundary.
 */
describe('invitations router', () => {
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
    // Both invitations.invited_by AND memberships.invited_by FK to users — every row in either
    // table must be gone before ANY user is deleted (not just "before its own creator" — the
    // invitee's accepted membership can reference a DIFFERENT user, the inviter, as invited_by).
    // So every FK-dependent table is fully cleared across all created orgs/users first, then users,
    // then organizations — never interleaved per-user, which is what caused the FK violation.
    for (const orgId of createdOrgIds) {
      await db.delete(invitations).where(eq(invitations.organizationId, orgId));
    }
    for (const userId of createdUserIds) {
      await db.delete(memberships).where(eq(memberships.userId, userId));
      await db.delete(verificationTokens).where(eq(verificationTokens.userId, userId));
    }
    for (const userId of createdUserIds) {
      const tokens = await redis.smembers(`user-sessions:${userId}`);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => `session:${t}`), `user-sessions:${userId}`);
      }
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

  /** Creates a real verified user with an accepted membership, logs in via the real endpoint, and returns the real session cookie. */
  const loginAs = async (role: 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER_FINANCE') => {
    const email = uniqueEmail(`invite-${role.toLowerCase()}`);
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });

    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    // UUID v7 is time-ordered — its first 8 hex chars encode the millisecond timestamp, so two
    // ids generated in the same millisecond (routine when a test calls loginAs() twice in a row)
    // share an identical prefix. Using the full id (or its random tail) avoids the collision that
    // truncating to the leading chars caused.
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
      role,
      acceptedAt: new Date(),
    });

    const login = await rpc(app, 'auth.login', { email, password });
    return { userId, organizationId, email, cookie: login.cookies['__Host-session']! };
  };

  /** Adds a second real accepted member to an EXISTING org and logs them in — for tests that need two members of the same org rather than `loginAs`'s own fresh org per call. */
  const addAndLoginMember = async (organizationId: string, role: 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER_FINANCE') => {
    const email = uniqueEmail(`member-${role.toLowerCase()}`);
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date() });
    const membershipId = generateId();
    await db.insert(memberships).values({ id: membershipId, organizationId, userId, role, acceptedAt: new Date() });

    const login = await rpc(app, 'auth.login', { email, password });
    return { userId, membershipId, email, cookie: login.cookies['__Host-session']! };
  };

  it('an OWNER can create a real invitation', async () => {
    const owner = await loginAs('OWNER');

    const { status, body } = await rpc(
      app,
      'invitations.create',
      { email: 'newteammate@example.test', role: 'STAFF', storeIds: null },
      owner.cookie
    );

    expect(status).toBe(200);
    const data = asSuccess(body);
    expect(data.message).toBe('Invitation created.');
    expect(typeof data._devOnlyInvitationToken).toBe('string');

    const [row] = await db
      .select()
      .from(invitations)
      .where(eq(invitations.organizationId, owner.organizationId));
    expect(row?.email).toBe('newteammate@example.test');
    expect(row?.role).toBe('STAFF');
    expect(row?.invitedBy).toBe(owner.userId);
  });

  it('a STAFF member (no users:manage) is forbidden from creating an invitation', async () => {
    const staff = await loginAs('STAFF');

    const { status, body } = await rpc(
      app,
      'invitations.create',
      { email: 'someone@example.test', role: 'STAFF', storeIds: null },
      staff.cookie
    );

    expect(status).toBe(403);
    expect(asError(body).message).toBe('You do not have permission to invite members.');
  });

  it('an unauthenticated caller (no session cookie) is rejected', async () => {
    const { status, body } = await rpc(app, 'invitations.create', {
      email: 'someone@example.test',
      role: 'STAFF',
      storeIds: null,
    });

    expect(status).toBe(401);
    expect(asError(body).message).toBe('Not signed in.');
  });

  it('the invited user can log in via the real pending-invitation session and accept, creating a real membership', async () => {
    const owner = await loginAs('OWNER');
    const inviteeEmail = uniqueEmail('real-invitee');
    const inviteePassword = 'a-genuinely-long-password-123';
    const inviteeId = generateId();
    createdUserIds.push(inviteeId);
    await db.insert(users).values({
      id: inviteeId,
      email: inviteeEmail,
      passwordHash: await hashPassword(inviteePassword),
      emailVerifiedAt: new Date(),
    });

    const created = await rpc(
      app,
      'invitations.create',
      { email: inviteeEmail, role: 'MANAGER', storeIds: null },
      owner.cookie
    );
    const token = asSuccess(created.body)._devOnlyInvitationToken as string;

    // The invitee has zero accepted memberships — auth.login's pending-invitation fallback (see
    // establishSessionForUser) is what gives them a real session here, not a hand-crafted one.
    const login = await rpc(app, 'auth.login', { email: inviteeEmail, password: inviteePassword });
    expect(login.status).toBe(200);
    const inviteeCookie = login.cookies['__Host-session']!;

    const { status, body } = await rpc(app, 'invitations.accept', { token }, inviteeCookie);

    expect(status).toBe(200);
    expect(asSuccess(body).organizationId).toBe(owner.organizationId);

    const [membershipRow] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, inviteeId));
    expect(membershipRow?.role).toBe('MANAGER');
    expect(membershipRow?.organizationId).toBe(owner.organizationId);
  });

  it('the pending-invitation login session has zero permissions — it can accept the invite and nothing else', async () => {
    const owner = await loginAs('OWNER');
    const inviteeEmail = uniqueEmail('zero-perm-invitee');
    const inviteePassword = 'a-genuinely-long-password-123';
    const inviteeId = generateId();
    createdUserIds.push(inviteeId);
    await db.insert(users).values({
      id: inviteeId,
      email: inviteeEmail,
      passwordHash: await hashPassword(inviteePassword),
      emailVerifiedAt: new Date(),
    });

    await rpc(app, 'invitations.create', { email: inviteeEmail, role: 'MANAGER', storeIds: null }, owner.cookie);

    const login = await rpc(app, 'auth.login', { email: inviteeEmail, password: inviteePassword });
    const inviteeCookie = login.cookies['__Host-session']!;

    // Trying to invite someone else with this pre-membership session must be forbidden — an empty
    // permission set denies users:manage exactly like any other permission, per packages/authz's
    // fail-closed rule. This session exists to accept ONE specific invite, nothing more.
    const forbidden = await rpc(
      app,
      'invitations.create',
      { email: 'someone-else@example.test', role: 'STAFF', storeIds: null },
      inviteeCookie
    );

    expect(forbidden.status).toBe(403);
  });

  it('a user with no account and no pending invitation still gets the generic zero-membership rejection at login', async () => {
    const email = uniqueEmail('truly-nobody');
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash: await hashPassword(password),
      emailVerifiedAt: new Date(),
    });

    const { status, body } = await rpc(app, 'auth.login', { email, password });

    expect(status).toBe(401);
    expect(asError(body).message).toBe('Invalid credentials.');
  });

  it("rejects acceptance when the signed-in caller's email does not match the invitation's invitee email", async () => {
    const owner = await loginAs('OWNER');
    const wrongUser = await loginAs('STAFF'); // a different real, logged-in account

    const created = await rpc(
      app,
      'invitations.create',
      { email: 'someone-else-entirely@example.test', role: 'MANAGER', storeIds: null },
      owner.cookie
    );
    const token = asSuccess(created.body)._devOnlyInvitationToken as string;

    const { status, body } = await rpc(app, 'invitations.accept', { token }, wrongUser.cookie);

    expect(status).toBe(400);
    expect(asError(body).message).toBe('This invitation is invalid or has expired.');

    const [membershipRow] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, wrongUser.userId));
    // Only their original STAFF membership exists — no second membership was created for the org
    // the invitation was actually for.
    expect(membershipRow?.organizationId).toBe(wrongUser.organizationId);
  });

  it('rejects an unrecognized or already-consumed invitation token with a generic error', async () => {
    const owner = await loginAs('OWNER');

    const { status, body } = await rpc(
      app,
      'invitations.accept',
      { token: 'this-token-was-never-issued' },
      owner.cookie
    );

    expect(status).toBe(400);
    expect(asError(body).message).toBe('This invitation is invalid or has expired.');
  });

  it("updateRole revokes the demoted member's existing session immediately, not at its natural expiry", async () => {
    const owner = await loginAs('OWNER');
    const manager = await addAndLoginMember(owner.organizationId, 'MANAGER');

    // The demoted member's session is live and valid before the role change.
    const before = await queryRpc(app, 'invitations.listMembers', {}, manager.cookie);
    expect(before.status).toBe(403); // MANAGER lacks users:manage — proves the session works at all, just not for this endpoint

    const { status } = await rpc(
      app,
      'invitations.updateRole',
      { membershipId: manager.membershipId, role: 'STAFF' },
      owner.cookie
    );
    expect(status).toBe(200);

    // Same cookie, now revoked — any authenticated call must reject as if never logged in.
    const after = await queryRpc(app, 'invitations.listMembers', {}, manager.cookie);
    expect(after.status).toBe(401);
  });

  it("removeMember revokes the removed member's existing session immediately", async () => {
    const owner = await loginAs('OWNER');
    const staff = await addAndLoginMember(owner.organizationId, 'STAFF');

    const { status } = await rpc(app, 'invitations.removeMember', { membershipId: staff.membershipId }, owner.cookie);
    expect(status).toBe(200);

    const after = await queryRpc(app, 'invitations.listMembers', {}, staff.cookie);
    expect(after.status).toBe(401);
  });
});
