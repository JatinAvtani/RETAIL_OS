import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { menuItems } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { MenuItemRepository } from './menu-item-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('MenuItemRepository cross-tenant isolation', () => {
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
    await adminDb.delete(menuItems).where(eq(menuItems.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(menuItems).where(eq(menuItems.organizationId, fixture.tenantB.organizationId));
  });

  afterAll(async () => {
    await client.end();
    await adminClient.end();
    await fixture.cleanup();
  });

  it("never returns tenant B's menu item when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoB = new MenuItemRepository(db, fixture.tenantB.organizationId);
    const item = await repoB.create({
      id: generateId(),
      name: 'Tenant B Latte',
      recipeGroupId: generateId(),
      price: '4.5000',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const repoA = new MenuItemRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findById(item.id);

    expect(result).toBeNull();
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new MenuItemRepository(db, '')).toThrow(/organizationId/);
  });
});
