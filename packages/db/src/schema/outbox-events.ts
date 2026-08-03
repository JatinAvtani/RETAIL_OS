import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * The transactional outbox (I8, spec 09 §9.4): a state change and its event MUST commit together
 * or not at all — publishing inline (a separate call to Redis after `COMMIT`) can succeed on one
 * side and fail on the other, producing a stock update with no event, silently. This table is what
 * makes that failure mode structurally impossible: `INSERT INTO outbox_events` happens inside the
 * SAME transaction as the state-changing writes it describes.
 *
 * `publishedAt` starts `NULL` and is set once a relay process has actually delivered the event to
 * Redis — no such relay is built yet (out of scope for 005-06, confirmed with the user: this table
 * and the transactional write are the correctness-critical piece; a real polling/delivery worker is
 * separate infrastructure for whenever `apps/worker` gets a scheduling story). Unpublished rows
 * accumulating safely if Redis is down is itself part of the design (spec 09 §9.4's failure table).
 *
 * Not partitioned — spec 08 §8.8's partitioning table does not list `outbox_events`, unlike
 * `stock_movements`/`audit_logs`/`notifications`; outbox rows are short-lived (deleted or archived
 * once published, by whichever future job manages retention) rather than an append-only ledger of
 * permanent record.
 *
 * `aggregateType`/`aggregateId`/`eventType`/`payload` match spec 09 §9.4's literal example
 * (`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload,
 * organization_id)`) exactly — no columns invented beyond what the spec's own snippet names.
 */
export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});
