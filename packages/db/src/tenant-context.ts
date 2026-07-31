import type { PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type * as schema from './schema/index';

export type Tx = PostgresJsTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

/**
 * Sets the RLS session variable for the current transaction ONLY, via SET LOCAL — never bare
 * SET (spec 08 SS8.1, plan.md Phase 5 verify step). A bare SET persists on the underlying
 * connection; once that connection returns to the pool, the next unrelated request could
 * inherit the previous tenant's organization_id, which is a cross-tenant leak with a completely
 * different mechanism than a missing WHERE clause.
 *
 * Must be called as the FIRST statement inside the transaction that will run tenant-scoped
 * queries — SET LOCAL's scope is "until end of transaction," so calling it outside a transaction
 * (or in a different transaction than the queries that follow) does nothing useful.
 *
 * Uses set_config(..., true) rather than literal `SET LOCAL app.current_org_id = '...'` SQL:
 * they are equivalent (the third argument, is_local=true, IS SET LOCAL's semantics), but
 * set_config is a normal function call, so organizationId can be passed as a bound parameter
 * instead of being interpolated into SQL text — removing any temptation to string-concatenate a
 * user-controlled value into a SET statement.
 */
export const withTenantContext = async <T>(
  tx: Tx,
  organizationId: string,
  fn: () => Promise<T>
): Promise<T> => {
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${organizationId}, true)`);
  return fn();
};
