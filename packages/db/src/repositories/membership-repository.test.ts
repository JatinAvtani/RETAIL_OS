import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { memberships, organizations, users } from '../schema/index';
import { MembershipRepository } from './membership-repository';

/**
 * Proves the SECURITY DEFINER function (drizzle/0005_login_membership_lookup.sql) actually does
 * what it's for: reading a user's memberships across organizations they belong to, as the real
 * non-superuser retailos_app role, with NO app.current_org_id set at all — the exact situation
 * that would throw for any ordinary RLS-protected query on this table (see
 * rls-only.cross-tenant.test.ts for that failure mode proven directly).
 */
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

describe('MembershipRepository.findAcceptedMembershipsForLogin', () => {
  let adminClient: ReturnType<typeof postgres>;
  let adminDb: ReturnType<typeof drizzle<typeof schema>>;
  let appClient: ReturnType<typeof postgres>;
  let repo: MembershipRepository;
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(() => {
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    adminDb = drizzle(adminClient, { schema });
    appClient = postgres(APP_CONNECTION_STRING);
    const appDb = drizzle(appClient, { schema });
    repo = new MembershipRepository(appDb);
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(memberships).where(eq(memberships.organizationId, orgId));
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
    await adminDb.insert(users).values({ id: userId, email });
    return userId;
  };

  it('returns memberships across multiple organizations for the same user, with no org context set', async () => {
    const orgA = await makeOrg(`Org A ${Date.now()}`);
    const orgB = await makeOrg(`Org B ${Date.now()}`);
    const userId = await makeUser(`multi-org-${Date.now()}@example.test`);

    await adminDb.insert(memberships).values({
      id: generateId(),
      organizationId: orgA,
      userId,
      role: 'OWNER',
      acceptedAt: new Date(),
    });
    await adminDb.insert(memberships).values({
      id: generateId(),
      organizationId: orgB,
      userId,
      role: 'MANAGER',
      acceptedAt: new Date(),
    });

    const result = await repo.findAcceptedMembershipsForLogin(userId);

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.organizationId).sort()).toEqual([orgA, orgB].sort());
  });

  it('excludes a membership that has not been accepted (a pending invite)', async () => {
    const orgId = await makeOrg(`Pending Invite Org ${Date.now()}`);
    const userId = await makeUser(`pending-${Date.now()}@example.test`);

    await adminDb.insert(memberships).values({
      id: generateId(),
      organizationId: orgId,
      userId,
      role: 'STAFF',
      acceptedAt: null,
    });

    const result = await repo.findAcceptedMembershipsForLogin(userId);

    expect(result).toHaveLength(0);
  });

  it('returns an empty array for a user with no memberships at all', async () => {
    const userId = await makeUser(`no-memberships-${Date.now()}@example.test`);

    const result = await repo.findAcceptedMembershipsForLogin(userId);

    expect(result).toEqual([]);
  });

  it("never returns another user's memberships", async () => {
    const orgId = await makeOrg(`Isolated Org ${Date.now()}`);
    const userA = await makeUser(`user-a-${Date.now()}@example.test`);
    const userB = await makeUser(`user-b-${Date.now()}@example.test`);

    await adminDb.insert(memberships).values({
      id: generateId(),
      organizationId: orgId,
      userId: userA,
      role: 'OWNER',
      acceptedAt: new Date(),
    });

    const resultForB = await repo.findAcceptedMembershipsForLogin(userB);

    expect(resultForB).toEqual([]);
  });
});

describe('MembershipRepository.findByUserAndOrg', () => {
  let adminClient: ReturnType<typeof postgres>;
  let adminDb: ReturnType<typeof drizzle<typeof schema>>;
  let appClient: ReturnType<typeof postgres>;
  let repo: MembershipRepository;
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(() => {
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    adminDb = drizzle(adminClient, { schema });
    appClient = postgres(APP_CONNECTION_STRING);
    const appDb = drizzle(appClient, { schema });
    repo = new MembershipRepository(appDb);
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(memberships).where(eq(memberships.organizationId, orgId));
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
      slug: `${label.toLowerCase().replace(/\s+/g, '-')}-${organizationId}`,
      baseCurrency: 'USD',
    });
    return organizationId;
  };

  const makeUser = async (email: string) => {
    const userId = generateId();
    createdUserIds.push(userId);
    await adminDb.insert(users).values({ id: userId, email });
    return userId;
  };

  it('returns the real, current approvalLimit for a real membership — read fresh, not cached on a session', async () => {
    const orgId = await makeOrg(`Approval Limit Org ${Date.now()}`);
    const userId = await makeUser(`approval-limit-${Date.now()}@example.test`);
    await adminDb.insert(memberships).values({
      id: generateId(),
      organizationId: orgId,
      userId,
      role: 'MANAGER',
      approvalLimit: '500.0000',
      acceptedAt: new Date(),
    });

    const result = await repo.findByUserAndOrg(userId, orgId);

    expect(result).not.toBeNull();
    expect(result?.approvalLimit).toBe('500.0000');
    expect(result?.role).toBe('MANAGER');
  });

  it('returns approvalLimit: null (unrestricted) for a membership with no configured limit — never a fabricated zero (I7)', async () => {
    const orgId = await makeOrg(`No Limit Org ${Date.now()}`);
    const userId = await makeUser(`no-limit-${Date.now()}@example.test`);
    await adminDb.insert(memberships).values({
      id: generateId(),
      organizationId: orgId,
      userId,
      role: 'OWNER',
      acceptedAt: new Date(),
    });

    const result = await repo.findByUserAndOrg(userId, orgId);

    expect(result?.approvalLimit).toBeNull();
  });

  it('returns null for a real user with a real membership, but in a DIFFERENT organization (I4)', async () => {
    const orgA = await makeOrg(`Cross Org A ${Date.now()}`);
    const orgB = await makeOrg(`Cross Org B ${Date.now()}`);
    const userId = await makeUser(`cross-org-${Date.now()}@example.test`);
    await adminDb.insert(memberships).values({
      id: generateId(),
      organizationId: orgA,
      userId,
      role: 'OWNER',
      acceptedAt: new Date(),
    });

    const result = await repo.findByUserAndOrg(userId, orgB);

    expect(result).toBeNull();
  });

  it('returns null for a user with no membership at all', async () => {
    const orgId = await makeOrg(`Empty Org ${Date.now()}`);
    const userId = await makeUser(`no-membership-${Date.now()}@example.test`);

    const result = await repo.findByUserAndOrg(userId, orgId);

    expect(result).toBeNull();
  });
});
