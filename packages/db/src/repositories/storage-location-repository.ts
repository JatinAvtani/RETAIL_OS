import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { storageLocations, stores } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * `storeId` is a separate FK to `stores`, not covered by the org-scoped WHERE clause
 * `TenantScopedRepository` ANDs in automatically — a store from a *different* org could still
 * share this org's tenant predicate if nothing checked it, so `create` verifies the store exists
 * within this same organization first, the same shape as `CategoryRepository.create` checking a
 * parent category before inserting a child.
 */
export class StorageLocationRepository extends TenantScopedRepository<typeof storageLocations> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, storageLocations, organizationId);
  }

  async findAll() {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(storageLocations)
        .where(scopedWhere(isNull(storageLocations.deletedAt)))
    );
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(storageLocations)
        .where(scopedWhere(and(eq(storageLocations.id, id), isNull(storageLocations.deletedAt))))
    );
    return rows[0] ?? null;
  }

  async findByStore(storeId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(storageLocations)
        .where(scopedWhere(and(eq(storageLocations.storeId, storeId), isNull(storageLocations.deletedAt))))
    );
  }

  async create(input: { id: string; storeId: string; name: string }) {
    return this.runScoped(async (db) => {
      const storeRows = await db
        .select({ id: stores.id })
        .from(stores)
        .where(and(eq(stores.id, input.storeId), eq(stores.organizationId, this.organizationId), isNull(stores.deletedAt)));
      if (storeRows.length === 0) {
        throw new Error(`Cannot create a storage location for storeId '${input.storeId}' — not found in this organization.`);
      }

      const rows = await db
        .insert(storageLocations)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          storeId: input.storeId,
          name: input.name,
        })
        .returning();
      const created = rows[0];
      if (!created) {
        throw new Error('Storage location insert returned no row.');
      }
      return created;
    });
  }
}
