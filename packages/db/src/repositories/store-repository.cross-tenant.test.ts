import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createScopedDb } from '../tenant-repository';
import { StoreRepository } from './store-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

/**
 * The merge gate (spec 08 SS8.1 point 4, plan.md Phase 6): an automated suite that attempts
 * cross-tenant access and asserts it is always denied. The plan's literal example tests HTTP
 * endpoints via callAs(user, endpoint); no HTTP endpoints exist yet (no api app code), so this
 * adapts the same principle to the layer that DOES exist today — StoreRepository, the
 * application-layer half of I4's defense in depth. The RLS half is proven separately in
 * store-repository.rls-only.test.ts, without going through any repository at all.
 *
 * Connects as retailos_app (the real, non-superuser application role), not postgres — a
 * superuser bypasses RLS, which would make this suite pass for the wrong reason.
 */
const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

describe('StoreRepository cross-tenant isolation', () => {
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

  it('never returns 200-equivalent (a row) for tenant B\'s store when scoped to tenant A', async () => {
    const db = createScopedDb(client);
    const repoA = new StoreRepository(db, fixture.tenantA.organizationId);

    const result = await repoA.findById(fixture.tenantB.storeId);

    expect(result).toBeNull();
  });

  it('symmetrically denies tenant A\'s store when scoped to tenant B', async () => {
    const db = createScopedDb(client);
    const repoB = new StoreRepository(db, fixture.tenantB.organizationId);

    const result = await repoB.findById(fixture.tenantA.storeId);

    expect(result).toBeNull();
  });

  it('findAll scoped to tenant A never includes tenant B\'s store', async () => {
    const db = createScopedDb(client);
    const repoA = new StoreRepository(db, fixture.tenantA.organizationId);

    const result = await repoA.findAll();

    expect(result.some((s) => s.id === fixture.tenantB.storeId)).toBe(false);
    expect(result.some((s) => s.id === fixture.tenantA.storeId)).toBe(true);
  });

  it('rejects construction with an empty organizationId rather than defaulting to "see everything"', async () => {
    const db = createScopedDb(client);

    expect(() => new StoreRepository(db, '')).toThrow(/organizationId/);
  });
});
