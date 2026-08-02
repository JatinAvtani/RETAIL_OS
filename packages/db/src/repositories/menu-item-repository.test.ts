import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { menuItems, organizations } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { MenuItemRepository } from './menu-item-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('MenuItemRepository', () => {
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
      name: 'Menu Item Test Org',
      slug: `menu-item-test-${organizationId}`,
      baseCurrency: 'USD',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(menuItems).where(eq(menuItems.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('creates a menu item linked to a recipe group', async () => {
    const repo = new MenuItemRepository(createScopedDb(client), organizationId);
    const recipeGroupId = generateId();
    const item = await repo.create({
      id: generateId(),
      name: 'Large Latte',
      recipeGroupId,
      price: '4.5000',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });

    expect(item.name).toBe('Large Latte');
    expect(item.recipeGroupId).toBe(recipeGroupId);
  });

  it('findByRecipeGroup returns every menu item linked to that recipe group', async () => {
    const repo = new MenuItemRepository(createScopedDb(client), organizationId);
    const recipeGroupId = generateId();
    await repo.create({
      id: generateId(),
      name: 'Large Latte',
      recipeGroupId,
      price: '4.5000',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.create({
      id: generateId(),
      name: 'Happy Hour Latte',
      recipeGroupId,
      price: '3.5000',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const found = await repo.findByRecipeGroup(recipeGroupId);
    expect(found).toHaveLength(2);
  });

  it('findById returns null for a nonexistent menu item', async () => {
    const repo = new MenuItemRepository(createScopedDb(client), organizationId);
    const result = await repo.findById(generateId());
    expect(result).toBeNull();
  });
});
