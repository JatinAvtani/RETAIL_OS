import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { recipeComponents, recipes } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { RecipeRepository } from './recipe-repository';
import { UnitRepository } from './unit-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('RecipeRepository cross-tenant isolation', () => {
  let fixture: TwoTenantFixture;
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let kgId: string;

  beforeAll(async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const unitRepo = new UnitRepository(drizzle(client, { schema }));
    kgId = (await unitRepo.findByCode('kg'))!.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    for (const org of [fixture.tenantA.organizationId, fixture.tenantB.organizationId]) {
      const orgRecipes = await adminDb.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, org));
      for (const r of orgRecipes) {
        await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await adminDb.delete(recipes).where(eq(recipes.organizationId, org));
    }
  });

  afterAll(async () => {
    await client.end();
    await adminClient.end();
    await fixture.cleanup();
  });

  it("never returns tenant B's recipe version when scoped to tenant A", async () => {
    const db = createScopedDb(client);
    const repoB = new RecipeRepository(db, fixture.tenantB.organizationId);
    const recipeGroupId = generateId();
    await repoB.create({
      id: generateId(),
      recipeGroupId,
      name: 'Tenant B Recipe',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [],
    });

    const repoA = new RecipeRepository(db, fixture.tenantA.organizationId);
    const result = await repoA.findVersionAsOf(recipeGroupId, new Date('2026-01-01T00:00:00Z'));

    expect(result).toBeNull();
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new RecipeRepository(db, '')).toThrow(/organizationId/);
  });
});
