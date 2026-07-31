import { and, eq, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';
import { withTenantContext } from './tenant-context';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A table this repository base can guard must expose an `organizationId` column — enforced at
 * the type level so a table without one (organizations, users — see schema comments on why they
 * have none) simply cannot be passed to `TenantScopedRepository`.
 */
type TenantScopedTable = PgTable & { organizationId: unknown };

/**
 * I4 layer 3 (spec 08 SS8.1): "a base repository that refuses to build a query without an org
 * scope." This is independent of RLS, not a wrapper around it — RLS catches what the app misses,
 * this catches what RLS misconfiguration misses (e.g. someone disables FORCE ROW LEVEL SECURITY,
 * or a future migration on a new table forgets the policy). Two mechanisms that both have to
 * fail for a cross-tenant leak to occur.
 *
 * Enforced two ways, not one:
 *  1. Construction requires a non-empty organizationId — there is no code path that produces a
 *     TenantScopedRepository instance without one (see the constructor guard below).
 *  2. Every query this class runs is (a) wrapped in withTenantContext, setting the RLS session
 *     variable for that transaction, AND (b) has `organization_id = this.organizationId` ANDed
 *     into its WHERE clause explicitly at the query-builder level — so the app-layer predicate
 *     exists even if RLS were somehow misconfigured or disabled on this table.
 */
export abstract class TenantScopedRepository<T extends TenantScopedTable> {
  protected readonly organizationId: string;
  private readonly db: Db;
  private readonly table: T;

  constructor(db: Db, table: T, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error(
        `${new.target.name} constructed without an organizationId — every tenant-scoped ` +
          'repository must be scoped to exactly one organization for its lifetime (I4).'
      );
    }
    this.db = db;
    this.table = table;
    this.organizationId = organizationId;
  }

  /**
   * ANDs the tenant predicate into any additional WHERE condition. Callers build queries through
   * this, never by reading `this.table` directly and writing a bare `.where(...)` — there is no
   * method on this class that runs a query without going through `runScoped`, which always calls
   * this internally.
   */
  private scopedWhere(extra?: SQL): SQL {
    const orgColumn = (this.table as unknown as { organizationId: unknown }).organizationId;
    const tenantPredicate = eq(orgColumn as never, this.organizationId);
    return extra ? (and(tenantPredicate, extra) as SQL) : tenantPredicate;
  }

  /**
   * Runs `fn` inside a transaction that has already had `app.current_org_id` set via SET LOCAL
   * (through withTenantContext) for this repository's organizationId. Every public method a
   * subclass exposes must go through this — it is the only way this class touches the database.
   */
  protected async runScoped<R>(fn: (db: Db, scopedWhere: (extra?: SQL) => SQL) => Promise<R>): Promise<R> {
    return this.db.transaction((tx) =>
      withTenantContext(tx as never, this.organizationId, () =>
        fn(tx as unknown as Db, (extra) => this.scopedWhere(extra))
      )
    );
  }
}

export const createScopedDb = (client: postgres.Sql) => drizzle(client, { schema });
