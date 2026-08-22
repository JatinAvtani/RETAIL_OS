import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from './schema/index';
import { stores } from './schema/index';
import { findActiveStoresForScheduling } from './briefing-schedule';
import { setUpTwoTenants, type TwoTenantFixture } from './test-support/tenant-fixture';

const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Proves the real cross-tenant scheduling sweep against real Postgres — deliberately uses
 * the ADMIN connection directly, matching `findUnpublishedOutboxEvents`'s own precedent, since
 * `findActiveStoresForScheduling` is a genuine cross-tenant sweep by design (the schedule-poll tick
 * needs every active store across every tenant, not one tenant's own scoped view).
 */
describe('findActiveStoresForScheduling: the real per-store-timezone scheduling read side', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let fixture: TwoTenantFixture;

  afterAll(async () => {
    await client.end();
    await fixture.cleanup();
  });

  it('a cross-tenant sweep sees active stores from BOTH tenants, with their real timezone, and excludes a CLOSED store', async () => {
    fixture = await setUpTwoTenants();
    client = postgres(ADMIN_CONNECTION_STRING);
    db = drizzle(client, { schema });

    // setUpTwoTenants seeds one ACTIVE America/New_York store per tenant by default.
    const before = await findActiveStoresForScheduling(db);
    const beforeStoreIds = before.map((s) => s.storeId);
    expect(beforeStoreIds).toContain(fixture.tenantA.storeId);
    expect(beforeStoreIds).toContain(fixture.tenantB.storeId);

    const tenantAResult = before.find((s) => s.storeId === fixture.tenantA.storeId);
    expect(tenantAResult?.organizationId).toBe(fixture.tenantA.organizationId);
    expect(tenantAResult?.timezone).toBe('America/New_York');

    // Close tenant B's store — a real, live status transition, not a fixture assumption.
    await db.update(stores).set({ status: 'closed' }).where(eq(stores.id, fixture.tenantB.storeId));

    const after = await findActiveStoresForScheduling(db);
    const afterStoreIds = after.map((s) => s.storeId);
    expect(afterStoreIds).toContain(fixture.tenantA.storeId); // tenant A's store is still active
    expect(afterStoreIds).not.toContain(fixture.tenantB.storeId); // tenant B's is now closed, excluded
  });
});
