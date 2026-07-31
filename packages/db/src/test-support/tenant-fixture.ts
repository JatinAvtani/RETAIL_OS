import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { organizations, stores } from '../schema/index';
import { generateId } from '@retailos/domain';

/**
 * Test-only helper: creates two real, isolated tenants (with one store each) directly in the
 * database the tests run against, and tears them down afterward. Deliberately does NOT reuse
 * fixed UUIDs across test files — each call generates fresh IDs, so tests can run concurrently
 * or repeatedly without colliding, unlike the throwaway fixed-UUID scripts used to manually
 * verify 001-07/001-08.
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
    const storeName = `${label} Store ${storeId.slice(0, 8)}`;

    await adminDb.insert(organizations).values({
      id: organizationId,
      name: `${label} Org`,
      baseCurrency: 'USD',
    });
    await adminDb.insert(stores).values({
      id: storeId,
      organizationId,
      name: storeName,
      timezone: 'America/New_York',
    });

    return { organizationId, storeId, storeName };
  };

  const tenantA = await makeTenant('Tenant-A');
  const tenantB = await makeTenant('Tenant-B');

  const cleanup = async () => {
    await adminDb.delete(stores).where(eq(stores.organizationId, tenantA.organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, tenantB.organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, tenantA.organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, tenantB.organizationId));
    await client.end();
  };

  return { tenantA, tenantB, cleanup };
};
