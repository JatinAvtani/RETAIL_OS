import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { setUpTwoTenants, type TwoTenantFixture } from './test-support/tenant-fixture';

/**
 * Proves RLS alone blocks cross-tenant reads, with NO application-layer WHERE organization_id
 * predicate at all — simulating a hypothetical future repository that forgets to scope its
 * query (seed two tenants, connect as retailos_app, query with no predicate, confirm only the
 * current tenant's row comes back). If a future migration disables FORCE ROW LEVEL SECURITY on a
 * tenant table, or a policy is dropped, this test fails — that is the point of it existing
 * independently of the repository-layer test in store-repository.cross-tenant.test.ts.
 */
const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

describe('RLS alone (no repository, no app-layer WHERE clause)', () => {
  let fixture: TwoTenantFixture;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
  });

  afterAll(async () => {
    await client.end();
    await fixture.cleanup();
  });

  it('a query with no organization_id predicate at all still excludes other tenants\' rows', async () => {
    const rows = await client.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${fixture.tenantA.organizationId}, true)`;
      // Deliberately no WHERE clause on organization_id — this is what a buggy repository
      // that forgot scopedWhere would run.
      return tx`SELECT id, organization_id FROM stores`;
    });

    expect(rows.some((r) => r.id === fixture.tenantB.storeId)).toBe(false);
    expect(rows.some((r) => r.id === fixture.tenantA.storeId)).toBe(true);
  });

  it('a transaction with no SET LOCAL at all fails loudly rather than leaking a previous context', async () => {
    await expect(
      client.begin(async (tx) => {
        // No set_config call in this transaction at all.
        return tx`SELECT id FROM stores`;
      })
    ).rejects.toThrow();
  });

  it('RLS blocks cross-tenant reads of memberships, including approval_limit and invited_by', async () => {
    const rows = await client.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${fixture.tenantA.organizationId}, true)`;
      return tx`SELECT id, organization_id, approval_limit, invited_by FROM memberships`;
    });

    expect(rows.some((r) => r.id === fixture.tenantB.membershipId)).toBe(false);
    expect(rows.some((r) => r.id === fixture.tenantA.membershipId)).toBe(true);
  });
});
