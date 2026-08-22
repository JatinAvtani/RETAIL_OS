import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { memberships, organizations, stores, users } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { MembershipListRepository } from './membership-list-repository';

const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

/**
 * Proves `findAcceptedByRoles` — the real recipient-resolution query the notification
 * fan-out depends on — against real Postgres: role filtering, the ACCEPTED-only rule (matching
 * `listAcceptedMembers`' own precedent), and store-scoping (null storeIds means every store, a
 * non-empty array restricts to exactly those stores, matching `notification_rules.storeId`'s own
 * "null means org-wide" semantics on the other side of this same relationship).
 */
describe('MembershipListRepository.findAcceptedByRoles', () => {
  let adminClient: ReturnType<typeof postgres>;
  let adminDb: ReturnType<typeof drizzle<typeof schema>>;
  let appClient: ReturnType<typeof postgres>;

  const organizationId = generateId();
  const storeAId = generateId();
  const storeBId = generateId();
  const managerOrgWideUserId = generateId();
  const managerStoreAOnlyUserId = generateId();
  const managerStoreBOnlyUserId = generateId();
  const staffOrgWideUserId = generateId();
  const pendingManagerUserId = generateId();

  beforeAll(async () => {
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    adminDb = drizzle(adminClient, { schema });
    appClient = postgres(APP_CONNECTION_STRING);

    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Recipient Resolution Org',
      slug: `recipient-resolution-org-${organizationId}`,
      baseCurrency: 'USD',
    });
    await adminDb.insert(stores).values([
      { id: storeAId, organizationId, name: `Store A ${storeAId}`, timezone: 'America/New_York' },
      { id: storeBId, organizationId, name: `Store B ${storeBId}`, timezone: 'America/New_York' },
    ]);
    await adminDb.insert(users).values([
      { id: managerOrgWideUserId, email: `manager-orgwide-${managerOrgWideUserId}@example.test` },
      { id: managerStoreAOnlyUserId, email: `manager-storea-${managerStoreAOnlyUserId}@example.test` },
      { id: managerStoreBOnlyUserId, email: `manager-storeb-${managerStoreBOnlyUserId}@example.test` },
      { id: staffOrgWideUserId, email: `staff-orgwide-${staffOrgWideUserId}@example.test` },
      { id: pendingManagerUserId, email: `manager-pending-${pendingManagerUserId}@example.test` },
    ]);
    await adminDb.insert(memberships).values([
      { id: generateId(), organizationId, userId: managerOrgWideUserId, role: 'MANAGER', storeIds: null, acceptedAt: new Date() },
      { id: generateId(), organizationId, userId: managerStoreAOnlyUserId, role: 'MANAGER', storeIds: [storeAId], acceptedAt: new Date() },
      { id: generateId(), organizationId, userId: managerStoreBOnlyUserId, role: 'MANAGER', storeIds: [storeBId], acceptedAt: new Date() },
      { id: generateId(), organizationId, userId: staffOrgWideUserId, role: 'STAFF', storeIds: null, acceptedAt: new Date() },
      // Never accepted — must be excluded regardless of role/store match.
      { id: generateId(), organizationId, userId: pendingManagerUserId, role: 'MANAGER', storeIds: null, acceptedAt: null },
    ]);
  });

  afterEach(async () => {
    await appClient.end().catch(() => {});
  });

  afterAll(async () => {
    await adminDb.delete(memberships).where(eq(memberships.organizationId, organizationId));
    await adminDb.delete(users).where(eq(users.id, managerOrgWideUserId));
    await adminDb.delete(users).where(eq(users.id, managerStoreAOnlyUserId));
    await adminDb.delete(users).where(eq(users.id, managerStoreBOnlyUserId));
    await adminDb.delete(users).where(eq(users.id, staffOrgWideUserId));
    await adminDb.delete(users).where(eq(users.id, pendingManagerUserId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await adminClient.end();
  });

  it('returns only ACCEPTED members with a matching role, excluding a pending invite entirely', async () => {
    const db = createScopedDb(postgres(APP_CONNECTION_STRING));
    const repo = new MembershipListRepository(db, organizationId);

    const recipients = await repo.findAcceptedByRoles(null, ['MANAGER']);
    const userIds = recipients.map((r) => r.userId);

    expect(userIds).toContain(managerOrgWideUserId);
    expect(userIds).toContain(managerStoreAOnlyUserId);
    expect(userIds).toContain(managerStoreBOnlyUserId);
    expect(userIds).not.toContain(pendingManagerUserId); // never accepted
    expect(userIds).not.toContain(staffOrgWideUserId); // wrong role
  });

  it('a store-scoped alert (storeId provided) includes org-wide members AND that store-specific member, excludes a different store-specific member', async () => {
    const db = createScopedDb(postgres(APP_CONNECTION_STRING));
    const repo = new MembershipListRepository(db, organizationId);

    const recipients = await repo.findAcceptedByRoles(storeAId, ['MANAGER']);
    const userIds = recipients.map((r) => r.userId);

    expect(userIds).toContain(managerOrgWideUserId); // storeIds: null -> every store
    expect(userIds).toContain(managerStoreAOnlyUserId); // matches this exact store
    expect(userIds).not.toContain(managerStoreBOnlyUserId); // restricted to a DIFFERENT store
  });

  it('an org-wide alert (storeId null) includes every accepted member of the matching role regardless of their own store restriction', async () => {
    const db = createScopedDb(postgres(APP_CONNECTION_STRING));
    const repo = new MembershipListRepository(db, organizationId);

    const recipients = await repo.findAcceptedByRoles(null, ['MANAGER']);
    const userIds = recipients.map((r) => r.userId);

    expect(userIds).toContain(managerOrgWideUserId);
    expect(userIds).toContain(managerStoreAOnlyUserId);
    expect(userIds).toContain(managerStoreBOnlyUserId);
  });

  it('multiple roles are matched with OR semantics, not AND', async () => {
    const db = createScopedDb(postgres(APP_CONNECTION_STRING));
    const repo = new MembershipListRepository(db, organizationId);

    const recipients = await repo.findAcceptedByRoles(null, ['MANAGER', 'STAFF']);
    const userIds = recipients.map((r) => r.userId);

    expect(userIds).toContain(managerOrgWideUserId);
    expect(userIds).toContain(staffOrgWideUserId);
  });
});
