import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { users } from './users';
import { salesSourceEnum } from './sales';
import { idColumn, timestamps } from './columns';

export const posConnectionStatusEnum = pgEnum('pos_connection_status', [
  'CONNECTED',
  'DEGRADED',
  'FAILED',
  'EXPIRED',
  'DISCONNECTED',
]);

/**
 * 006-03: one store's link to a vendor POS account (spec 13 §13.3's "per-tenant credential
 * isolation"). Reuses `salesSourceEnum` (006-01) for `vendor` rather than a narrower dedicated
 * enum — asked the user, confirmed: `'csv'` simply never appears as a real row here (CSV import has
 * no persistent connection to store, it's a one-off upload each time), and one enum for "which POS
 * vendor" everywhere avoids a second near-identical enum to keep in sync whenever a real vendor is
 * added.
 *
 * Exactly one row per `(store, vendor)` — a store cannot have two simultaneous Square connections.
 * `storeId`, not `organizationId` alone, is the scope: spec 13 names Square's own model as
 * location-scoped (one connection authorizes one `externalLocationId`), matching this codebase's
 * own store-not-org boundary for stock/sales/counts.
 *
 * `accessTokenCiphertext`/`refreshTokenCiphertext` hold AES-256-GCM output (`packages/pos`'s
 * `encryptToken`/`decryptToken`), never plaintext — spec 13 §13.3 calls for "envelope encryption,
 * KMS-managed key"; this codebase's no-card/no-cost constraint rules out a real cloud KMS (AWS
 * KMS/GCP KMS both require a billing account), so the KEY MANAGEMENT layer is deliberately
 * simplified to a single symmetric key from an environment variable (`POS_TOKEN_ENCRYPTION_KEY`,
 * same free/no-card pattern as `GOOGLE_CLIENT_SECRET`/`GEMINI_API_KEY`) — recorded as ADR-14, a
 * real, deliberate deviation, not a silent downgrade. The ENCRYPTION itself (tokens never stored
 * plaintext, never logged) is unchanged; only the key-rotation/HSM/audit-trail infrastructure a
 * managed KMS would add is absent.
 *
 * `status` surfaces spec 13 §13.4's integration health requirement directly on this row rather than
 * inferring it from token expiry alone — a sync can be `DEGRADED` (partial failures, still
 * connected) independent of whether the OAuth token itself has actually `EXPIRED`.
 */
export const posConnections = pgTable(
  'pos_connections',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    vendor: salesSourceEnum('vendor').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    externalLocationId: text('external_location_id'),
    accessTokenCiphertext: text('access_token_ciphertext').notNull(),
    refreshTokenCiphertext: text('refresh_token_ciphertext'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    status: posConnectionStatusEnum('status').notNull().default('CONNECTED'),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    connectedByUserId: uuid('connected_by_user_id').references(() => users.id),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('pos_connections_store_vendor_idx').on(table.storeId, table.vendor)]
);
