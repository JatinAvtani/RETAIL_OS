import { integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { users } from './users';
import { idColumn } from './columns';

/**
 * Groups the documents from one bulk-upload session (spec 03 M9's "bulk invoice backfill") so a
 * caller can poll real, scoped progress — "47 of 90 processed" for THIS session, not an all-time
 * count across the whole store. `expectedCount` is set once, at creation, from the real number of
 * files the client is about to upload — never guessed or left null, since the progress UI's whole
 * point is a real denominator. Purely a grouping label: no state machine of its own, no new event
 * emission — completion is derived by counting the real `documents.status` values of its member
 * rows at read time, never cached or duplicated here (I2).
 */
export const documentUploadBatches = pgTable('document_upload_batches', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  expectedCount: integer('expected_count').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
