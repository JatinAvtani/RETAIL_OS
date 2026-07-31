import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { invitations } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';
import { hashToken, invitationExpiry, issueInvitationToken, type IssuedToken } from '../auth/invitation-token';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type InvitationLookup = {
  id: string;
  organizationId: string;
  email: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER_FINANCE';
  storeIds: string[] | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

export type AcceptedInvitationMembership = {
  membershipId: string;
  organizationId: string;
  role: InvitationLookup['role'];
  storeIds: string[] | null;
};

export type PendingInvitationForEmail = {
  organizationId: string;
  role: InvitationLookup['role'];
};

/**
 * Creating an invitation is a normal, RLS-scoped write — the inviter is already an authenticated
 * member of the org they're inviting into, so this extends `TenantScopedRepository` exactly like
 * `StoreRepository` (see its doc comment). Resolving/accepting an invitation by token is the
 * opposite case: it happens before the invitee has any org context at all — the same
 * chicken-and-egg shape `MembershipRepository`'s login lookup solves — so those two operations go
 * through narrow `SECURITY DEFINER` SQL functions (`drizzle/0007_invitations.sql`) instead, called
 * as plain static-style methods that don't go through `runScoped` at all (there is no
 * organizationId to scope to yet at the point they're called).
 */
export class InvitationRepository extends TenantScopedRepository<typeof invitations> {
  constructor(db: Db, organizationId: string) {
    super(db, invitations, organizationId);
  }

  /**
   * Snapshots role + storeIds at issue time, per plan.md ("scoped to the exact org+role at issue
   * time, so changing the invite later doesn't grant more"). Returns the raw token — never
   * persisted — so the caller can email it.
   */
  async create(params: {
    email: string;
    role: InvitationLookup['role'];
    storeIds: string[] | null;
    invitedBy: string;
  }): Promise<{ invitationId: string; token: IssuedToken }> {
    const invitationId = generateId();
    const token = issueInvitationToken();

    await this.runScoped((db) =>
      db.insert(invitations).values({
        id: invitationId,
        organizationId: this.organizationId,
        email: params.email,
        role: params.role,
        storeIds: params.storeIds,
        tokenHash: token.hash,
        invitedBy: params.invitedBy,
        expiresAt: invitationExpiry(),
      })
    );

    return { invitationId, token };
  }
}

/**
 * The token-scoped half of invitation handling — deliberately NOT a method on
 * `InvitationRepository` (that class requires an `organizationId` at construction, and there is no
 * organizationId to provide yet when a caller only has a raw token). A plain module-level function
 * taking `db` directly, mirroring `MembershipRepository.findAcceptedMembershipsForLogin`'s shape:
 * both bypass RLS via a narrow, explicitly granted SECURITY DEFINER function, never touching the
 * table directly.
 */
export const findInvitationByTokenHash = async (
  db: Db,
  rawToken: string
): Promise<InvitationLookup | null> => {
  const tokenHash = hashToken(rawToken);
  const rows = await db.execute<{
    id: string;
    organization_id: string;
    email: string;
    role: InvitationLookup['role'];
    store_ids: string[] | null;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
  }>(sql`SELECT * FROM find_invitation_by_token_hash(${tokenHash})`);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role,
    storeIds: row.store_ids,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
};

/**
 * Login needs this to solve a real gap: a brand-new invitee has zero accepted memberships, so
 * `auth.login`'s normal rejection would apply — but they need SOME session to ever call
 * `acceptInvitationByTokenHash` in the first place. Returns every pending, unexpired invitation for
 * the email, across every organization, via the same cross-org SECURITY DEFINER pattern as
 * `MembershipRepository.findAcceptedMembershipsForLogin`. More than one result is a genuine,
 * unsupported case (mirroring the existing "multiple accepted memberships" gap) — the caller
 * decides what to do with that, this function only reports what exists.
 */
export const findPendingInvitationsByEmail = async (
  db: Db,
  email: string
): Promise<PendingInvitationForEmail[]> => {
  const rows = await db.execute<{ organization_id: string; role: InvitationLookup['role'] }>(
    sql`SELECT * FROM find_pending_invitation_by_email(${email})`
  );

  return rows.map((row) => ({ organizationId: row.organization_id, role: row.role }));
};

/**
 * Marks the invitation accepted AND creates the real membership row in one atomic operation (a
 * CTE inside the SQL function chains both, so they succeed or fail together — see
 * `drizzle/0007_invitations.sql`). `userId` is the CALLER'S OWN authenticated identity; the tRPC
 * procedure calling this must independently confirm (via `findInvitationByTokenHash`) that the
 * caller's own email matches the invitation before ever calling this function — that check is what
 * prevents "accepting while logged in as a different user silently creates a membership for the
 * wrong account" (plan.md's explicitly named bug class), not anything inside this function itself.
 */
export const acceptInvitationByTokenHash = async (
  db: Db,
  rawToken: string,
  userId: string
): Promise<AcceptedInvitationMembership | null> => {
  const tokenHash = hashToken(rawToken);
  const rows = await db.execute<{
    membership_id: string;
    organization_id: string;
    role: InvitationLookup['role'];
    store_ids: string[] | null;
  }>(sql`SELECT * FROM accept_invitation_by_token_hash(${tokenHash}, ${userId}::uuid)`);

  const row = rows[0];
  if (!row) return null;

  return {
    membershipId: row.membership_id,
    organizationId: row.organization_id,
    role: row.role,
    storeIds: row.store_ids,
  };
};
