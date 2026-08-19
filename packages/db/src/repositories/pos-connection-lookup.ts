import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import type { SalesSource } from './pos-item-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type ConnectionByExternalAccount = {
  id: string;
  organizationId: string;
  storeId: string;
};

/**
 * earlier work's version of the same chicken-and-egg problem `MembershipRepository`
 * (`find_accepted_memberships_for_login`, migration 0005) solves for login: a webhook arrives
 * carrying only Square's `merchant_id` — no `organizationId` is known yet, and `pos_connections` has
 * FORCE ROW LEVEL SECURITY requiring `app.current_org_id` to already be set. Queries a narrow,
 * explicitly granted `SECURITY DEFINER` SQL function (`find_pos_connection_by_external_account`,
 * migration 0027) instead of the table directly, same reasoning as `MembershipRepository`: the
 * function bypasses RLS for exactly this one pre-tenant-context read, `retailos_app` has EXECUTE on
 * the function and nothing else, and every other `pos_connections` query still goes through
 * `PosConnectionRepository`'s normal RLS-protected path once an `organizationId` is known.
 */
export class PosConnectionLookup {
  constructor(private readonly db: Db) {}

  async findByExternalAccount(vendor: SalesSource, externalAccountId: string): Promise<ConnectionByExternalAccount | null> {
    const rows = await this.db.execute<{ id: string; organization_id: string; store_id: string }>(
      sql`SELECT * FROM find_pos_connection_by_external_account(${vendor}::sales_source, ${externalAccountId})`
    );
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, organizationId: row.organization_id, storeId: row.store_id };
  }
}
