import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type AcceptedMembership = {
  id: string;
  organizationId: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER_FINANCE';
  storeIds: string[] | null;
  approvalLimit: string | null;
};

/**
 * Not a TenantScopedRepository, and deliberately not a normal Drizzle query either: finding a
 * user's memberships ACROSS every organization they belong to is the one legitimate case where a
 * query is keyed by user_id, not organization_id — there is no single tenant to scope to yet,
 * which is exactly the situation `memberships`' FORCE ROW LEVEL SECURITY policy is designed to
 * reject (it requires app.current_org_id to already be set). This queries a narrow, explicitly
 * granted `SECURITY DEFINER` SQL function (see drizzle/0005_login_membership_lookup.sql) instead
 * of the table directly — the function bypasses RLS for exactly this one read, `retailos_app` has
 * EXECUTE on the function and nothing else, and every other membership query in the codebase still
 * goes through the normal RLS-protected path once an organization_id is known (e.g. once inside
 * TenantScopedRepository after a session/AuthContext has picked one).
 */
export class MembershipRepository {
  constructor(private readonly db: Db) {}

  /** Only accepted memberships — a pending invite is not a valid login target. */
  async findAcceptedMembershipsForLogin(userId: string): Promise<AcceptedMembership[]> {
    const rows = await this.db.execute<{
      id: string;
      organization_id: string;
      role: AcceptedMembership['role'];
      store_ids: string[] | null;
      approval_limit: string | null;
    }>(sql`SELECT * FROM find_accepted_memberships_for_login(${userId}::uuid)`);

    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      role: row.role,
      storeIds: row.store_ids,
      approvalLimit: row.approval_limit,
    }));
  }
}
