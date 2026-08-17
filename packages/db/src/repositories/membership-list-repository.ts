import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { memberships, users } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * The real "list every member of my org" capability — genuinely missing until now (found while
 * building the team-management UI). Deliberately a SEPARATE class from `MembershipRepository`
 * (`membership-repository.ts`), not a new method on it: that class exists specifically for the
 * PRE-TENANT lookups (login, cross-org queries via a SECURITY DEFINER function, no organizationId
 * known yet) — this class is the ordinary, RLS-scoped, `TenantScopedRepository` case for an
 * already-authenticated caller listing their OWN org's accepted members, matching
 * `InvitationRepository`'s own precedent for "creating/reading within a known org is a normal
 * tenant-scoped write; the token-based pre-tenant half is a separate module."
 */
export class MembershipListRepository extends TenantScopedRepository<typeof memberships> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, memberships, organizationId);
  }

  /** Every real ACCEPTED member (`acceptedAt IS NOT NULL` — this schema's own convention, no separate status column), joined to the user's own email/name for display. Ordered newest-first so a recently-invited-and-accepted teammate is easy to find. */
  async listAcceptedMembers() {
    return this.runScoped((db, scopedWhere) =>
      db
        .select({
          membershipId: memberships.id,
          userId: memberships.userId,
          email: users.email,
          name: users.name,
          role: memberships.role,
          storeIds: memberships.storeIds,
          acceptedAt: memberships.acceptedAt,
        })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(scopedWhere(and(isNull(memberships.deletedAt), isNotNull(memberships.acceptedAt))))
        .orderBy(desc(memberships.acceptedAt))
    );
  }

  /** Changes an existing member's role. Refuses to change the caller's own role away from OWNER if they're the org's only OWNER — enforced by the caller (the router), not here; this method is a plain write. Refuses a non-existent membership (returns null) rather than throwing, matching this codebase's established `rows[0] ?? null` convention. */
  async updateRole(membershipId: string, role: 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER_FINANCE') {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(memberships)
        .set({ role, updatedAt: new Date() })
        .where(scopedWhere(and(eq(memberships.id, membershipId), isNull(memberships.deletedAt))))
        .returning()
    );
    return rows[0] ?? null;
  }

  /** Soft-removes a member from the org — never a hard delete (matches this codebase's own soft-delete-master-data convention). */
  async removeMember(membershipId: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(memberships)
        .set({ deletedAt: new Date() })
        .where(scopedWhere(and(eq(memberships.id, membershipId), isNull(memberships.deletedAt))))
        .returning()
    );
    return rows[0] ?? null;
  }

  /** How many ACCEPTED OWNER memberships exist — used by the router to refuse demoting/removing the org's last owner, which would strand the organization with no one able to manage it. */
  async countAcceptedOwners(): Promise<number> {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select({ id: memberships.id })
        .from(memberships)
        .where(scopedWhere(and(eq(memberships.role, 'OWNER'), isNull(memberships.deletedAt), isNotNull(memberships.acceptedAt))))
    );
    return rows.length;
  }
}
