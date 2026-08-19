import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { memberships } from '../schema/index';
import { withTenantContext } from '../tenant-context';

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

  /**
   * The ordinary, in-org membership lookup — unlike `findAcceptedMembershipsForLogin` above, this
   * runs AFTER a session already picked one `organizationId`, so it goes through the normal
   * RLS-protected path via a real `withTenantContext`-wrapped transaction (a plain `db.select()`
   * against `memberships`, a `FORCE ROW LEVEL SECURITY` table, throws `unrecognized configuration
   * parameter "app.current_org_id"` without this — the same class of bug confirmed 3x in this
   * codebase; see project memory `retailos-tenant-context-outside-repository`). Used by earlier work's
   * PO approval flow to read the CURRENT `approvalLimit` fresh at approval time, never a stale
   * value cached on the session at login — a manager's limit can change after they logged in.
   */
  async findByUserAndOrg(userId: string, organizationId: string): Promise<AcceptedMembership | null> {
    return this.db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        const rows = await tx
          .select({
            id: memberships.id,
            organizationId: memberships.organizationId,
            role: memberships.role,
            storeIds: memberships.storeIds,
            approvalLimit: memberships.approvalLimit,
          })
          .from(memberships)
          .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)));
        return rows[0] ?? null;
      })
    );
  }
}
