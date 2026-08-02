import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { organizations, recipes } from '../schema/index';
import { UnitRepository } from './unit-repository';
import { createScopedDb } from '../tenant-repository';
import { generateId } from '@retailos/domain';

const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

/**
 * Mirrors supplier-price-repository.test.ts's direct database-level proof: this test bypasses
 * RecipeRepository entirely and inserts through the raw Drizzle table object, proving the
 * recipes_no_overlapping_versions exclusion constraint is a real database backstop, not something
 * only application logic (RecipeRepository.createNewVersion's close-then-insert dance) prevents.
 */
describe('recipes exclusion constraint (database-level proof, bypassing RecipeRepository)', () => {
  let adminClient: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let organizationId: string;
  let kgId: string;

  beforeAll(async () => {
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    client = postgres(APP_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Exclusion Test Org',
      slug: `excl-recipe-${organizationId}`,
      baseCurrency: 'USD',
    });
    const unitRepo = new UnitRepository(createScopedDb(client));
    kgId = (await unitRepo.findByCode('kg'))!.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(recipes).where(eq(recipes.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await adminClient.end();
    await client.end();
  });

  it('rejects a second open-ended version of the same recipe group inserted directly', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const recipeGroupId = generateId();

    await adminDb.insert(recipes).values({
      id: generateId(),
      recipeGroupId,
      organizationId,
      name: 'V1',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
    });

    await expect(
      adminDb.insert(recipes).values({
        id: generateId(),
        recipeGroupId,
        organizationId,
        name: 'V2 overlapping',
        yieldQuantity: '1',
        yieldUnitId: kgId,
        validFrom: new Date('2026-02-01T00:00:00Z'),
      })
    ).rejects.toThrow(/exclusion constraint/);
  });

  it('accepts a correctly closed-then-reopened version sequence', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const recipeGroupId = generateId();

    await adminDb.insert(recipes).values({
      id: generateId(),
      recipeGroupId,
      organizationId,
      name: 'V1',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validTo: new Date('2026-02-01T00:00:00Z'),
    });

    await expect(
      adminDb.insert(recipes).values({
        id: generateId(),
        recipeGroupId,
        organizationId,
        name: 'V2',
        yieldQuantity: '1',
        yieldUnitId: kgId,
        validFrom: new Date('2026-02-01T00:00:00Z'),
      })
    ).resolves.toBeDefined();
  });

  it('does not conflict across two different recipe groups with overlapping ranges', async () => {
    const adminDb = drizzle(adminClient, { schema });

    await adminDb.insert(recipes).values({
      id: generateId(),
      recipeGroupId: generateId(),
      organizationId,
      name: 'Recipe One',
      yieldQuantity: '1',
      yieldUnitId: kgId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
    });

    await expect(
      adminDb.insert(recipes).values({
        id: generateId(),
        recipeGroupId: generateId(),
        organizationId,
        name: 'Recipe Two',
        yieldQuantity: '1',
        yieldUnitId: kgId,
        validFrom: new Date('2026-01-01T00:00:00Z'),
      })
    ).resolves.toBeDefined();
  });
});
