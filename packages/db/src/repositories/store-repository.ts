import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { stores } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * Worked example proving TenantScopedRepository is usable, not just designed. Every method here
 * goes through `runScoped`, so there is no method that queries `stores` without both (a) the RLS
 * session variable set for this transaction and (b) an explicit organization_id predicate.
 *
 * The table is fixed to `stores` in this constructor, not passed by the caller — a repository
 * that let callers pass an arbitrary table would let a caller accidentally scope a StoreRepository
 * to the wrong table, which defeats the point of a repository being table-specific in the first
 * place.
 */
export class StoreRepository extends TenantScopedRepository<typeof stores> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, stores, organizationId);
  }

  async findAll() {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(stores)
        .where(scopedWhere(isNull(stores.deletedAt)))
    );
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(stores)
        .where(scopedWhere(and(eq(stores.id, id), isNull(stores.deletedAt))))
    );
    return rows[0] ?? null;
  }
}
