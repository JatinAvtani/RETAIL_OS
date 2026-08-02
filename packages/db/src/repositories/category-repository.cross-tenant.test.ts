import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { categories } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { CategoryRepository } from './category-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('CategoryRepository cross-tenant isolation', () => {
  let fixture: TwoTenantFixture;
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;

  beforeAll(async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(categories).where(eq(categories.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(categories).where(eq(categories.organizationId, fixture.tenantB.organizationId));
  });

  afterAll(async () => {
    await client.end();
    await adminClient.end();
    await fixture.cleanup();
  });

  it("never returns tenant B's category when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoB = new CategoryRepository(db, fixture.tenantB.organizationId);
    const categoryId = generateId();
    await repoB.create({ id: categoryId, name: 'Tenant B Category' });

    const repoA = new CategoryRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findById(categoryId);

    expect(result).toBeNull();
  });

  it("findAll scoped to tenant A never includes tenant B's categories", async () => {
    const db = createScopedDb(client);
    const repoA = new CategoryRepository(db, fixture.tenantA.organizationId);
    const repoB = new CategoryRepository(db, fixture.tenantB.organizationId);
    const ownId = generateId();
    const otherId = generateId();
    await repoA.create({ id: ownId, name: 'Tenant A Category' });
    await repoB.create({ id: otherId, name: 'Tenant B Category' });

    const result = await repoA.findAll();

    expect(result.some((c) => c.id === otherId)).toBe(false);
    expect(result.some((c) => c.id === ownId)).toBe(true);
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new CategoryRepository(db, '')).toThrow(/organizationId/);
  });
});
