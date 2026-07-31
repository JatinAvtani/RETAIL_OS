import { pgTable, text } from 'drizzle-orm/pg-core';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

/**
 * Global identity — one login can belong to multiple organizations (the accountant/multi-org-owner
 * persona), so `users` deliberately has no organization_id. The org relationship, and the role
 * within it, lives in `memberships`. Auth-specific columns (password hash, etc.) are added later,
 * not here — this migration only establishes identity, not authentication.
 */
export const users = pgTable('users', {
  id: idColumn(),
  email: text('email').notNull(),
  name: text('name'),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
