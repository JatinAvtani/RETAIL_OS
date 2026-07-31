import { pgEnum, pgTable, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { users } from './users';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

/**
 * Roles are deliberately coarse for MVP; expand this enum (via migration, not by adding a
 * separate roles table) when a real permission model is needed.
 */
export const membershipRoleEnum = pgEnum('membership_role', [
  'owner',
  'manager',
  'staff',
  'accountant',
]);

/**
 * Joins User <-> Organization with a Role, plus optional store scoping (spec 07 SS7.2). Modeling
 * role as a column on User would break the accountant persona and multi-org owners on day one —
 * this is why it's a join entity rather than a user attribute.
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
  storeId: uuid('store_id').references(() => stores.id),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
