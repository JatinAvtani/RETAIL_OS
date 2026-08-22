import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { onboardingProgress } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { OnboardingRepository } from './onboarding-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('OnboardingRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let fixture: TwoTenantFixture;

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(onboardingProgress).where(eq(onboardingProgress.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(onboardingProgress).where(eq(onboardingProgress.organizationId, fixture.tenantB.organizationId));
    await client.end();
    await fixture.cleanup();
  });

  it('findOrCreate returns a real row, every step PENDING, on first call — and the SAME row on a second call', async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);

    const db = createScopedDb(client);
    const repo = new OnboardingRepository(db, fixture.tenantA.organizationId);

    const first = await repo.findOrCreate();
    expect(first.salesConnectedStatus).toBe('PENDING');
    expect(first.invoicesUploadedStatus).toBe('PENDING');
    expect(first.entitiesConfirmedStatus).toBe('PENDING');
    expect(first.parLevelsSetStatus).toBe('PENDING');
    expect(first.dismissed).toBe(false);

    const second = await repo.findOrCreate();
    expect(second.id).toBe(first.id);
  });

  it('setStepStatus updates exactly the named step and leaves the others untouched', async () => {
    const db = createScopedDb(client);
    const repo = new OnboardingRepository(db, fixture.tenantA.organizationId);

    const updated = await repo.setStepStatus('invoicesUploadedStatus', 'DONE');
    expect(updated.invoicesUploadedStatus).toBe('DONE');
    expect(updated.salesConnectedStatus).toBe('PENDING');
    expect(updated.entitiesConfirmedStatus).toBe('PENDING');
    expect(updated.parLevelsSetStatus).toBe('PENDING');

    const skipped = await repo.setStepStatus('entitiesConfirmedStatus', 'SKIPPED');
    expect(skipped.entitiesConfirmedStatus).toBe('SKIPPED');
    expect(skipped.invoicesUploadedStatus).toBe('DONE');
  });

  it('dismiss sets dismissed=true without touching step statuses', async () => {
    const db = createScopedDb(client);
    const repo = new OnboardingRepository(db, fixture.tenantA.organizationId);

    await repo.dismiss();
    const row = await repo.findOrCreate();
    expect(row.dismissed).toBe(true);
    expect(row.invoicesUploadedStatus).toBe('DONE');
  });

  it('tenant isolation: tenant B never sees tenant A\'s onboarding row, and gets its own independent one', async () => {
    const dbA = createScopedDb(client);
    const repoA = new OnboardingRepository(dbA, fixture.tenantA.organizationId);
    const rowA = await repoA.findOrCreate();

    const dbB = createScopedDb(client);
    const repoB = new OnboardingRepository(dbB, fixture.tenantB.organizationId);
    const rowB = await repoB.findOrCreate();

    expect(rowB.id).not.toBe(rowA.id);
    expect(rowB.salesConnectedStatus).toBe('PENDING');

    // Tenant B's own writes never touch tenant A's row, even after A's steps were mutated above.
    const rowAAgain = await repoA.findOrCreate();
    expect(rowAAgain.invoicesUploadedStatus).toBe('DONE');
  });
});
