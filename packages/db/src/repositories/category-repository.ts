import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { categories } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * `path` is maintained here, not left to the caller — a category's path is derived entirely from
 * its own id and its parent's path, so computing it anywhere else risks two categories disagreeing
 * about the correct value. Root categories (no parent) get `path = '/' + id`; children get
 * `parentPath + '/' + id`.
 */
export class CategoryRepository extends TenantScopedRepository<typeof categories> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, categories, organizationId);
  }

  async findAll() {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(categories)
        .where(scopedWhere(isNull(categories.deletedAt)))
    );
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(categories)
        .where(scopedWhere(and(eq(categories.id, id), isNull(categories.deletedAt))))
    );
    return rows[0] ?? null;
  }

  async create(input: { id: string; name: string; parentId?: string }) {
    const parent = input.parentId ? await this.findById(input.parentId) : null;
    if (input.parentId && !parent) {
      throw new Error(`Cannot create a category under parentId '${input.parentId}' — not found in this organization.`);
    }
    const path = parent ? `${parent.path}/${input.id}` : `/${input.id}`;

    const rows = await this.runScoped((db) =>
      db
        .insert(categories)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          parentId: input.parentId ?? null,
          name: input.name,
          path,
        })
        .returning()
    );
    const created = rows[0];
    if (!created) {
      throw new Error('Category insert returned no row.');
    }
    return created;
  }

  /** Every category whose path contains this one's id as an ancestor segment — its full subtree. */
  async findDescendants(categoryId: string) {
    const target = await this.findById(categoryId);
    if (!target) return [];

    const all = await this.findAll();
    return all.filter((c) => c.id !== categoryId && c.path.startsWith(`${target.path}/`));
  }
}
