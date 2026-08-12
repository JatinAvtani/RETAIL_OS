import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { OrganizationRepository } from './organization-repository';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('OrganizationRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Org Repo Test Org',
      slug: `org-repo-test-${organizationId}`,
      baseCurrency: 'USD',
    });
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('findMine returns this organization\'s own real row', async () => {
    const repo = new OrganizationRepository(createScopedDb(client), organizationId);
    const org = await repo.findMine();
    expect(org?.id).toBe(organizationId);
    expect(org?.matchPriceTolerancePercent).toBeNull();
  });

  it('updateMatchTolerances writes only the fields actually provided, leaving others untouched', async () => {
    const repo = new OrganizationRepository(createScopedDb(client), organizationId);
    await repo.updateMatchTolerances({ matchPriceTolerancePercent: '0.0500' });

    const afterFirst = await repo.findMine();
    expect(afterFirst?.matchPriceTolerancePercent).toBe('0.0500');
    expect(afterFirst?.matchPriceToleranceAbsolute).toBeNull();
    expect(afterFirst?.matchQuantityTolerancePercent).toBeNull();

    await repo.updateMatchTolerances({ matchQuantityTolerancePercent: '0.0300' });
    const afterSecond = await repo.findMine();
    // The price tolerance set in the FIRST call must still be there — the second call never
    // mentioned it, so it must not have been silently reset to null.
    expect(afterSecond?.matchPriceTolerancePercent).toBe('0.0500');
    expect(afterSecond?.matchQuantityTolerancePercent).toBe('0.0300');
  });

  it('an explicit null clears an override back to the default', async () => {
    const repo = new OrganizationRepository(createScopedDb(client), organizationId);
    await repo.updateMatchTolerances({ matchPriceTolerancePercent: null });
    const org = await repo.findMine();
    expect(org?.matchPriceTolerancePercent).toBeNull();
  });
});
