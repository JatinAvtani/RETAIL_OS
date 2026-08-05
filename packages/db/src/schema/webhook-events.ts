import { jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { posConnections } from './pos-connections';
import { salesSourceEnum } from './sales';
import { idColumn, timestamps } from './columns';

export const webhookEventTypeEnum = pgEnum('webhook_event_type', ['catalog.updated', 'transaction.updated']);

/**
 * 006-06 (plan.md Phase 2): "webhooks are best-effort at every vendor" (plan.md's own words) — this
 * table is the durable record of every verified, deduped event a webhook receiver ever accepted,
 * independent of whether the triggered sync afterward succeeded. Two jobs: (1) idempotency — a
 * vendor's own dedup key (`ExternalEvent.externalEventId`, e.g. Square's `event_id`) means a
 * retried delivery (guaranteed at-least-once by every vendor, researched directly against Square's
 * docs: unsuccessful deliveries retry for up to 24h) is recognized and skipped, never double-synced;
 * (2) audit trail — `processedAt`/`processingError` record whether the post-response sync actually
 * ran and succeeded, giving a future 006-13 health surface something real to read, and giving a
 * future worker (once `apps/worker` is real) unprocessed rows to pick up if this synchronous
 * best-effort attempt ever needs to become a genuinely retried background job.
 *
 * `organizationId` is NOT NULL, matching every other tenant table's RLS convention — asked the user,
 * confirmed: a webhook whose `merchant_id` resolves to no known `pos_connections` row (an orphaned
 * subscription, or a signature that happens to verify against the wrong key) is NEVER written here
 * at all. The route logs it server-side and returns 200 (nothing useful for Square to retry), rather
 * than relaxing this table's tenant-scoping to accommodate an org-unknown row.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    posConnectionId: uuid('pos_connection_id')
      .notNull()
      .references(() => posConnections.id),
    source: salesSourceEnum('source').notNull(),
    externalEventId: text('external_event_id').notNull(),
    eventType: webhookEventTypeEnum('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingError: text('processing_error'),
    ...timestamps,
  },
  (table) => [
    // Idempotency (plan.md Phase 2's exact acceptance criterion): the SAME vendor event, retried
    // any number of times, must be recognized as already-seen — scoped by organization (not just
    // source), matching every other idempotency index in this codebase (e.g.
    // sales_transactions_org_source_external_id_idx), since a bare (source, external_id) unique
    // index would collide if a vendor's own event ids were ever reused across independent merchant
    // accounts (not something this codebase should rely on the vendor never doing).
    uniqueIndex('webhook_events_org_source_external_event_id_idx').on(table.organizationId, table.source, table.externalEventId),
  ]
);
