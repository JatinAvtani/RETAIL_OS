import { pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

export const userStatusEnum = pgEnum('user_status', ['active', 'suspended']);

/**
 * Global identity — one login can belong to multiple organizations (the accountant/multi-org-owner
 * persona), so `users` deliberately has no organization_id. The org relationship, and the role
 * within it, lives in `memberships`. `passwordHash` is nullable because an OAuth-only account never
 * sets one — the auth logic that populates these columns (Argon2id hashing, verification-token
 * flow) is separate work; this migration only establishes the columns. `googleId` (Google's stable
 * numeric `sub` claim, stored as text) is nullable for the same reason in reverse — a
 * password-only account never sets it. Unique, not indexed-and-unenforced, since two users
 * claiming the same Google identity would be an account-confusion bug, not a valid state.
 */
export const users = pgTable('users', {
  id: idColumn(),
  email: text('email').notNull(),
  name: text('name'),
  passwordHash: text('password_hash'),
  googleId: text('google_id'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  status: userStatusEnum('status').notNull().default('active'),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
