import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { categories, organizations } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { CategoryRepository } from './category-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('CategoryRepository', () => {
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
      name: 'Category Test Org',
      slug: `category-test-${organizationId}`,
      baseCurrency: 'USD',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(categories).where(eq(categories.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('creates a root category with path = /id', async () => {
    const repo = new CategoryRepository(createScopedDb(client), organizationId);
    const id = generateId();
    const created = await repo.create({ id, name: 'Beverages' });

    expect(created.path).toBe(`/${id}`);
    expect(created.parentId).toBeNull();
  });

  it('creates a child category whose path extends the parent path', async () => {
    const repo = new CategoryRepository(createScopedDb(client), organizationId);
    const rootId = generateId();
    const childId = generateId();
    await repo.create({ id: rootId, name: 'Beverages' });
    const child = await repo.create({ id: childId, name: 'Coffee', parentId: rootId });

    expect(child.path).toBe(`/${rootId}/${childId}`);
    expect(child.parentId).toBe(rootId);
  });

  it('rejects creating a category under a nonexistent parent', async () => {
    const repo = new CategoryRepository(createScopedDb(client), organizationId);
    await expect(repo.create({ id: generateId(), name: 'Orphan', parentId: generateId() })).rejects.toThrow(
      /not found/
    );
  });

  it('findDescendants returns the full subtree, not just direct children', async () => {
    const repo = new CategoryRepository(createScopedDb(client), organizationId);
    const rootId = generateId();
    const childId = generateId();
    const grandchildId = generateId();
    await repo.create({ id: rootId, name: 'Beverages' });
    await repo.create({ id: childId, name: 'Coffee', parentId: rootId });
    await repo.create({ id: grandchildId, name: 'Espresso-based', parentId: childId });

    const descendants = await repo.findDescendants(rootId);
    const descendantIds = descendants.map((d) => d.id).sort();

    expect(descendantIds).toEqual([childId, grandchildId].sort());
  });

  it('findDescendants excludes siblings and unrelated categories', async () => {
    const repo = new CategoryRepository(createScopedDb(client), organizationId);
    const rootAId = generateId();
    const rootBId = generateId();
    const childOfAId = generateId();
    await repo.create({ id: rootAId, name: 'Beverages' });
    await repo.create({ id: rootBId, name: 'Food' });
    await repo.create({ id: childOfAId, name: 'Coffee', parentId: rootAId });

    const descendantsOfB = await repo.findDescendants(rootBId);

    expect(descendantsOfB.map((d) => d.id)).not.toContain(childOfAId);
  });

  it('findAll excludes soft-deleted categories', async () => {
    const repo = new CategoryRepository(createScopedDb(client), organizationId);
    const id = generateId();
    await repo.create({ id, name: 'Beverages' });

    const adminDb = drizzle(adminClient, { schema });
    await adminDb.update(categories).set({ deletedAt: new Date() }).where(eq(categories.id, id));

    const all = await repo.findAll();
    expect(all.some((c) => c.id === id)).toBe(false);
  });
});
