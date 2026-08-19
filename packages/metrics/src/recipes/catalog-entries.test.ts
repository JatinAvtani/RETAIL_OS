import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId } from '@retailos/domain';
import {
  createDb,
  menuItems,
  organizations,
  recipeComponents,
  recipes,
  stores,
  units,
  withTenantContext,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that `menu_items_without_recipe` computes correctly through
 * `executeMetric`. `recipeGroupId` has deliberately no FK, so "no recipe" means no
 * CURRENTLY VALID `recipes` row for that group — this test proves both a menu item with a real
 * current recipe (excluded) and one with only an EXPIRED recipe version (counted, since it has no
 * currently valid one) are handled correctly, not just the trivial "recipeGroupId is some random
 * uuid with zero recipes rows at all" case.
 */
describe('registered recipe metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(menuItems).where(eq(menuItems.organizationId, orgId));
      const orgRecipes = await adminDb.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await adminDb.delete(recipes).where(eq(recipes.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await adminClient.end();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Recipe Metrics Test Org ${organizationId}`,
      slug: `recipe-metrics-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' })
      )
    );
    return { organizationId, storeId };
  };

  const auth = (permissions: readonly string[] = ['inventory:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });

  it('menu_items_without_recipe excludes a menu item with a real currently-valid recipe', async () => {
    const { organizationId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const recipeGroupId = generateId();
    const menuItemId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(recipes).values({
          id: generateId(),
          recipeGroupId,
          organizationId,
          name: 'Currently Valid Recipe',
          yieldQuantity: '1',
          yieldUnitId: eachUnit!.id,
          validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });
        await tx.insert(menuItems).values({
          id: menuItemId,
          organizationId,
          name: 'Item With Recipe',
          recipeGroupId,
          price: '10.0000',
          priceValidFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });
      })
    );

    const result = await executeMetric('menu_items_without_recipe', {}, auth(), plainCtx(organizationId));
    expect(result.value).toBe('0');
  });

  it('menu_items_without_recipe counts a menu item whose recipeGroupId has no currently valid recipe row at all', async () => {
    const { organizationId } = await setUpOrg();
    const menuItemId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(menuItems).values({
          id: menuItemId,
          organizationId,
          name: 'Item Without Recipe',
          recipeGroupId: generateId(),
          price: '10.0000',
          priceValidFrom: new Date(),
        })
      )
    );

    const result = await executeMetric('menu_items_without_recipe', {}, auth(), plainCtx(organizationId));
    expect(result.value).toBe('1');
  });

  it('menu_items_without_recipe counts a menu item whose only recipe version has already EXPIRED (validTo in the past)', async () => {
    const { organizationId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const recipeGroupId = generateId();
    const menuItemId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(recipes).values({
          id: generateId(),
          recipeGroupId,
          organizationId,
          name: 'Expired Recipe',
          yieldQuantity: '1',
          yieldUnitId: eachUnit!.id,
          validFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
          validTo: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });
        await tx.insert(menuItems).values({
          id: menuItemId,
          organizationId,
          name: 'Item With Expired Recipe',
          recipeGroupId,
          price: '10.0000',
          priceValidFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        });
      })
    );

    const result = await executeMetric('menu_items_without_recipe', {}, auth(), plainCtx(organizationId));
    expect(result.value).toBe('1');
  });

  it('executeMetric refuses a caller without inventory:read for menu_items_without_recipe', async () => {
    const { organizationId } = await setUpOrg();
    await expect(executeMetric('menu_items_without_recipe', {}, auth([]), plainCtx(organizationId))).rejects.toThrow(
      /inventory:read/
    );
  });
});
