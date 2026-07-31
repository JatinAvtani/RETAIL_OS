import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { memberships, organizations, stores, users } from '../schema/index';
import { generateId } from '@retailos/domain';

/**
 * Test-only helper: creates two real, isolated tenants (with one store each) directly in the
 * database the tests run against, and tears them down afterward. Deliberately does NOT reuse
 * fixed UUIDs across test files — each call generates fresh IDs, so tests can run concurrently
 * or repeatedly without colliding.
 *
 * Connects as `postgres` (not `retailos_app`) to seed/clean up, since seeding must write across
 * tenants in one call — exactly the kind of operation RLS is designed to prevent for the
 * application role. Test assertions themselves must still go through `retailos_app` /
 * TenantScopedRepository to mean anything.
 */
export type TenantFixture = {
  organizationId: string;
  storeId: string;
  storeName: string;
  userId: string;
  membershipId: string;
};

export type TwoTenantFixture = {
  tenantA: TenantFixture;
  tenantB: TenantFixture;
  cleanup: () => Promise<void>;
};

const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

export const setUpTwoTenants = async (): Promise<TwoTenantFixture> => {
  const client = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(client, { schema });

  const makeTenant = async (label: string): Promise<TenantFixture> => {
    const organizationId = generateId();
    const storeId = generateId();
    const userId = generateId();
    const membershipId = generateId();
    // Full ids, not truncated prefixes: UUID v7 is time-ordered, so its leading chars encode the
    // millisecond timestamp — two ids minted in the same millisecond (routine when this function
    // calls makeTenant twice in a row for tenant A and B) can share a prefix and collide on a
    // unique constraint (slug) that a truncated id was relied on to make unique.
    const storeName = `${label} Store ${storeId}`;

    await adminDb.insert(organizations).values({
      id: organizationId,
      name: `${label} Org`,
      slug: `${label.toLowerCase()}-org-${organizationId}`,
      baseCurrency: 'USD',
    });
    await adminDb.insert(stores).values({
      id: storeId,
      organizationId,
      name: storeName,
      timezone: 'America/New_York',
    });
    await adminDb.insert(users).values({
      id: userId,
      email: `${label.toLowerCase()}-${userId}@example.test`,
    });
    await adminDb.insert(memberships).values({
      id: membershipId,
      organizationId,
      userId,
      role: 'OWNER',
      storeIds: [storeId],
      approvalLimit: '500.0000',
    });

    return { organizationId, storeId, storeName, userId, membershipId };
  };

  const tenantA = await makeTenant('Tenant-A');
  const tenantB = await makeTenant('Tenant-B');

  const cleanup = async () => {
    await adminDb.delete(memberships).where(eq(memberships.organizationId, tenantA.organizationId));
    await adminDb.delete(memberships).where(eq(memberships.organizationId, tenantB.organizationId));
    await adminDb.delete(users).where(eq(users.id, tenantA.userId));
    await adminDb.delete(users).where(eq(users.id, tenantB.userId));
    await adminDb.delete(stores).where(eq(stores.organizationId, tenantA.organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, tenantB.organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, tenantA.organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, tenantB.organizationId));
    await client.end();
  };

  return { tenantA, tenantB, cleanup };
};
