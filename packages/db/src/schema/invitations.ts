import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';
import { membershipRoleEnum } from './memberships';
import { idColumn, timestamps } from './columns';

/**
 * A separate table from `memberships`, not a pending (accepted_at IS NULL) membership row —
 * `memberships.user_id` is NOT NULL, and an invitation must be sendable to an email address that
 * has no RetailOS account yet. Role and store scoping are captured here, at issue time, per
 * plan.md ("scoped to the exact org+role at issue time, so changing the invite later doesn't
 * grant more") — a real `memberships` row is only created once the invite is accepted, using
 * exactly this snapshot, not whatever the inviter's intent might be by then.
 *
 * RLS-scoped by organization_id like any other tenant table, EXCEPT the one read the accept flow
 * needs — looking up an invitation by its token, before the invitee's org context exists — which
 * goes through a narrow SECURITY DEFINER function (find_invitation_by_token), the same pattern
 * already established for login's cross-org membership lookup.
 */
export const invitations = pgTable('invitations', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  email: text('email').notNull(),
  role: membershipRoleEnum('role').notNull(),
  storeIds: uuid('store_ids').array(),
  tokenHash: text('token_hash').notNull(),
  invitedBy: uuid('invited_by')
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps,
});
