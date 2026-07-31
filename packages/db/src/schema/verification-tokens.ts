import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';
import { idColumn, timestamps } from './columns';

/**
 * email_verification and password_reset are structurally identical (user + hashed token + expiry
 * + single-use), so they share one table distinguished by purpose rather than two near-duplicate
 * tables — the different TTLs (24h vs 1h, see verification-token.ts) are an application-layer
 * concern, not a schema one.
 */
export const verificationTokenPurposeEnum = pgEnum('verification_token_purpose', [
  'email_verification',
  'password_reset',
]);

/**
 * Not RLS-scoped: like `users`, this table has no organization_id — a token belongs to a global
 * identity, not a tenant. Only `tokenHash` is ever stored, never the raw token (see
 * verification-token.ts) — a leaked row here must not itself grant account access.
 *
 * `usedAt` makes a token single-use: set on successful consumption, checked (must be NULL) before
 * accepting one. No soft-delete/version columns — these rows are consumed or expire, never edited.
 */
export const verificationTokens = pgTable('verification_tokens', {
  id: idColumn(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  purpose: verificationTokenPurposeEnum('purpose').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  ...timestamps,
});
