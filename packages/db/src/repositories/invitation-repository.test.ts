import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { invitations, memberships, organizations, users } from '../schema/index';
import {
  acceptInvitationByTokenHash,
  findInvitationByTokenHash,
  InvitationRepository,
} from './invitation-repository';

/**
 * Both halves proven against the real, non-superuser `retailos_app` role: `create` through the
 * normal RLS-protected TenantScopedRepository path (app.current_org_id genuinely set via SET
 * LOCAL), and the token-scoped functions through their SECURITY DEFINER bypass with NO org context
 * set at all — the exact chicken-and-egg situation that would throw for an ordinary query.
 */
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

describe('InvitationRepository', () => {
  let adminClient: ReturnType<typeof postgres>;
  let adminDb: ReturnType<typeof drizzle<typeof schema>>;
  let appClient: ReturnType<typeof postgres>;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(() => {
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    adminDb = drizzle(adminClient, { schema });
    appClient = postgres(APP_CONNECTION_STRING);
    appDb = drizzle(appClient, { schema });
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(memberships).where(eq(memberships.organizationId, orgId));
      await adminDb.delete(invitations).where(eq(invitations.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    for (const userId of createdUserIds) {
      await adminDb.delete(users).where(eq(users.id, userId));
    }
    createdOrgIds.length = 0;
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await adminClient.end();
    await appClient.end();
  });

  const makeOrg = async (label: string) => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: label,
      // Full id, not a truncated prefix: UUID v7 is time-ordered, so its leading chars encode the
      // millisecond timestamp and two ids minted in the same millisecond can share a prefix.
      slug: `${label.toLowerCase().replace(/\s+/g, '-')}-${organizationId}`,
      baseCurrency: 'USD',
    });
    return organizationId;
  };

  const makeUser = async (email: string) => {
    const userId = generateId();
    createdUserIds.push(userId);
    await adminDb.insert(users).values({ id: userId, email, emailVerifiedAt: new Date() });
    return userId;
  };

  it('create writes a real, RLS-scoped invitation row with a hashed token', async () => {
    const orgId = await makeOrg(`Invite Org ${Date.now()}`);
    const inviter = await makeUser(`inviter-${Date.now()}@example.test`);
    const repo = new InvitationRepository(appDb, orgId);

    const { invitationId, token } = await repo.create({
      email: 'invitee@example.test',
      role: 'MANAGER',
      storeIds: null,
      invitedBy: inviter,
    });

    const [row] = await adminDb.select().from(invitations).where(eq(invitations.id, invitationId));
    expect(row).toBeDefined();
    expect(row?.organizationId).toBe(orgId);
    expect(row?.role).toBe('MANAGER');
    expect(row?.tokenHash).not.toBe(token.raw); // never stored raw
    expect(row?.acceptedAt).toBeNull();
  });

  it('findInvitationByTokenHash resolves a real invitation with zero org context set', async () => {
    const orgId = await makeOrg(`Lookup Org ${Date.now()}`);
    const inviter = await makeUser(`inviter-${Date.now()}-lookup@example.test`);
    const repo = new InvitationRepository(appDb, orgId);

    const { token } = await repo.create({
      email: 'lookup-invitee@example.test',
      role: 'STAFF',
      storeIds: null,
      invitedBy: inviter,
    });

    const found = await findInvitationByTokenHash(appDb, token.raw);

    expect(found?.organizationId).toBe(orgId);
    expect(found?.email).toBe('lookup-invitee@example.test');
    expect(found?.role).toBe('STAFF');
    expect(found?.acceptedAt).toBeNull();
  });

  it('findInvitationByTokenHash returns null for a token that was never issued', async () => {
    const found = await findInvitationByTokenHash(appDb, 'this-token-was-never-issued');
    expect(found).toBeNull();
  });

  it('accept atomically marks the invitation accepted AND creates a real membership row', async () => {
    const orgId = await makeOrg(`Accept Org ${Date.now()}`);
    const inviter = await makeUser(`inviter-${Date.now()}-accept@example.test`);
    const invitee = await makeUser(`invitee-${Date.now()}-accept@example.test`);
    const repo = new InvitationRepository(appDb, orgId);

    const { token } = await repo.create({
      email: 'irrelevant-for-this-test@example.test',
      role: 'OWNER',
      storeIds: null,
      invitedBy: inviter,
    });

    const result = await acceptInvitationByTokenHash(appDb, token.raw, invitee);

    expect(result?.organizationId).toBe(orgId);
    expect(result?.role).toBe('OWNER');

    const [membershipRow] = await adminDb
      .select()
      .from(memberships)
      .where(eq(memberships.id, result!.membershipId));
    expect(membershipRow?.userId).toBe(invitee);
    expect(membershipRow?.organizationId).toBe(orgId);
    expect(membershipRow?.acceptedAt).not.toBeNull();

    const invitationAfter = await findInvitationByTokenHash(appDb, token.raw);
    expect(invitationAfter?.acceptedAt).not.toBeNull();
  });

  it('accept cannot be replayed — a second call with the same token returns null', async () => {
    const orgId = await makeOrg(`Replay Org ${Date.now()}`);
    const inviter = await makeUser(`inviter-${Date.now()}-replay@example.test`);
    const invitee = await makeUser(`invitee-${Date.now()}-replay@example.test`);
    const repo = new InvitationRepository(appDb, orgId);

    const { token } = await repo.create({
      email: 'replay@example.test',
      role: 'STAFF',
      storeIds: null,
      invitedBy: inviter,
    });

    const first = await acceptInvitationByTokenHash(appDb, token.raw, invitee);
    const second = await acceptInvitationByTokenHash(appDb, token.raw, invitee);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('accept returns null for an expired invitation', async () => {
    const orgId = await makeOrg(`Expired Org ${Date.now()}`);
    const inviter = await makeUser(`inviter-${Date.now()}-expired@example.test`);
    const invitee = await makeUser(`invitee-${Date.now()}-expired@example.test`);
    const repo = new InvitationRepository(appDb, orgId);

    const { invitationId, token } = await repo.create({
      email: 'expired@example.test',
      role: 'STAFF',
      storeIds: null,
      invitedBy: inviter,
    });
    await adminDb
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, invitationId));

    const result = await acceptInvitationByTokenHash(appDb, token.raw, invitee);

    expect(result).toBeNull();
  });

  it('accept returns null for a revoked invitation', async () => {
    const orgId = await makeOrg(`Revoked Org ${Date.now()}`);
    const inviter = await makeUser(`inviter-${Date.now()}-revoked@example.test`);
    const invitee = await makeUser(`invitee-${Date.now()}-revoked@example.test`);
    const repo = new InvitationRepository(appDb, orgId);

    const { invitationId, token } = await repo.create({
      email: 'revoked@example.test',
      role: 'STAFF',
      storeIds: null,
      invitedBy: inviter,
    });
    await adminDb.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, invitationId));

    const result = await acceptInvitationByTokenHash(appDb, token.raw, invitee);

    expect(result).toBeNull();
  });
});
