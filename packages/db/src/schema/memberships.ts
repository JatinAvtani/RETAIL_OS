import { numeric, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

/**
 * Matches the design's persona role codes exactly (OWNER/MANAGER/STAFF/VIEWER_FINANCE) —
 * originally created as lowercase owner/manager/staff/accountant before the spec's exact naming
 * was consulted; renamed in a later migration to avoid a permanent translation layer between the
 * DB and every piece of code that reads a role. PLATFORM_ADMIN is deliberately NOT a value here:
 * spec 4.7 describes it as an explicit, time-boxed, reason-logged grant onto tenant data, not an
 * ordinary org membership — modeling it as a membership role would misrepresent a support-staff
 * account as belonging to the customer's organization. Expand this enum via migration, not by
 * adding a separate roles table, when a real per-org custom-role feature is needed.
 */
export const membershipRoleEnum = pgEnum('membership_role', [
  'OWNER',
  'MANAGER',
  'STAFF',
  'VIEWER_FINANCE',
]);

/**
 * Joins User <-> Organization with a Role, plus optional store scoping. Modeling role as a column
 * on User would break the accountant persona and multi-org owners on day one — this is why it's
 * a join entity rather than a user attribute.
 *
 * storeIds is an array, not a join table: NULL means org-wide access (all current and future
 * stores), a non-empty array means scoped to exactly those stores. A join table would need a
 * separate "all stores" sentinel row anyway, and the org size this product targets (~50 stores
 * max) makes an array containment check simpler than a join for the same result. Deliberately no
 * FK on the array elements — Postgres can't express "each element of this uuid[] references
 * stores.id"; that referential check is enforced in application code instead, in the
 * authorization layer that builds AuthContext.
 *
 * approvalLimit is a PO approval threshold. Stored as NUMERIC(19,4) — the same precision as other
 * money columns in the spec — interpreted in the owning organization's base_currency, since a
 * membership has no currency of its own; the app layer wraps it in Money using
 * organizations.baseCurrency before any arithmetic (I5/I6). NULL means no limit (unrestricted),
 * not zero — a zero limit would incorrectly mean "cannot approve anything."
 */
export const memberships = pgTable('memberships', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  role: membershipRoleEnum('role').notNull(),
  storeIds: uuid('store_ids').array(),
  approvalLimit: numeric('approval_limit', { precision: 19, scale: 4 }),
  invitedBy: uuid('invited_by').references((): typeof users.id => users.id),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
