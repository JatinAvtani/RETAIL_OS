import { boolean, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { users } from './users';
import { idColumn, timestamps } from './columns';

/**
 * A rule's `storeId` is nullable — some alert types are inherently org-wide (margin drop, PO
 * awaiting approval can span stores) while most are store-scoped (stock below reorder, expiring
 * lots). Null means "applies to every store in the org," matching `notifications.storeId`'s own
 * nullability below for the same reason. `ruleType` is free text, not an enum: the alert
 * catalogue (11 types) is a starting set, not a closed one, and the rule engine is the real
 * authority on which types it knows how to evaluate — a DB enum would require a migration for
 * every new alert type, which is exactly the kind of churn `document_extractions.fields` (JSONB
 * over rigid columns) already avoids elsewhere in this schema.
 */
export const notificationRules = pgTable('notification_rules', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id').references(() => stores.id),
  ruleType: text('rule_type').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  threshold: jsonb('threshold').notNull(),
  severity: text('severity').notNull(),
  recipientRoles: text('recipient_roles').array().notNull(),
  channels: text('channels').array().notNull(),
  quietHours: jsonb('quiet_hours'),
  ...timestamps,
});

/**
 * `dedupKey` is what makes "the same issue recurring within the suppression window updates
 * rather than re-sends" mechanically enforceable — the rule engine looks up an existing OPEN
 * row by (organizationId, dedupKey) before deciding to INSERT vs UPDATE. `aggregationGroup` is
 * the separate mechanism for "5 expiring lots become 1 notification" — several distinct
 * dedup-keyed events can share one aggregation_group and be collapsed into a single row at
 * evaluation time; both are plain text so the rule engine owns the actual key format (documented
 * there, not here — this table only provides the columns).
 *
 * `dollarImpact` drives ranking ("ranked by dollar impact, not severity enum alone") — nullable
 * because not every alert type has a real dollar figure (e.g. "document requires review" has no
 * monetary value to report), matching this codebase's established unmapped-metric-tiering
 * precedent (see the briefing's own ranking logic in packages/assistant/src/briefing.ts): tier by
 * whether a real amount EXISTS, never synthesize one. `entityType`/`entityId` are free text/uuid
 * (no FK) since the referenced entity varies by rule_type (a lot, a purchase order, a
 * supplier_product...) — same "closed enum of entity kinds, open at the leaf" shape `audit_logs`
 * already established.
 *
 * `resolvedAt`/`actedAt`/`readAt` are three SEPARATE nullable timestamps, not a single status
 * enum, because they answer three genuinely different questions: a notification can resolve on
 * its own (the underlying condition clears, e.g. a restock) without any human ever seeing it; a
 * human can see it (`readAt`) without acting on it; and `actedAt` is reserved for a genuine
 * action (e.g. drafting a PO from "order more flour") — future action-rate tracking needs "acted
 * on" distinguished from merely "seen," and the in-app centre needs "seen" distinguished from
 * "the condition happened to clear." `readAt` was added later (confirmed with the user, not
 * reusing the earlier `actedAt`) precisely because no `notification_deliveries` row exists for
 * in-app notifications until real per-channel delivery (email) is built — `readAt` lives on
 * `notifications` itself so "has anyone at this store seen this" doesn't wait on that later work,
 * while `notification_deliveries.openedAt` remains the separate PER-USER, per-channel signal that
 * future delivery/action-rate work will use once real delivery rows exist.
 */
export const notifications = pgTable('notifications', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id').references(() => stores.id),
  ruleId: uuid('rule_id')
    .notNull()
    .references(() => notificationRules.id),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  dedupKey: text('dedup_key').notNull(),
  aggregationGroup: text('aggregation_group'),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  dollarImpact: numeric('dollar_impact', { precision: 19, scale: 4 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  actedAt: timestamp('acted_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
});

/**
 * One row per (notification, user, channel) — a single notification can fan out to several
 * recipients (`recipientRoles` above) across several channels (`channels`), and per-channel
 * retry/DLQ handling needs per-delivery-attempt state, not a single shared status on the
 * notification itself. `attempts` + `error` give that future work what it needs to implement
 * retry-with-backoff and a dead-letter cutoff without a separate queue-state table. `openedAt` is
 * what future action-rate tracking reads to compute "delivered but never opened" per alert type.
 *
 * `organizationId` is denormalized here for the same reason `messages.organizationId` is
 * (see conversations.ts) — every tenant-scoped child table in this codebase carries its own
 * `organization_id` directly rather than deriving tenant via a parent join, so
 * `TenantScopedRepository`'s flat `organization_id = current_setting(...)` RLS policy applies
 * uniformly. Written once at insert time from the parent notification's own org.
 */
export const notificationDeliveryStatusEnum = pgEnum('notification_delivery_status', [
  'PENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
  'DEAD_LETTERED',
]);
export type NotificationDeliveryStatus = (typeof notificationDeliveryStatusEnum.enumValues)[number];

export const notificationDeliveries = pgTable('notification_deliveries', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  notificationId: uuid('notification_id')
    .notNull()
    .references(() => notifications.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  channel: text('channel').notNull(),
  status: notificationDeliveryStatusEnum('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  error: text('error'),
});
