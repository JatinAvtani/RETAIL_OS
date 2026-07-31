import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Append-only record of every mutation (spec 08 SS8.5): actor, action, entity, before/after diff,
 * metadata, timestamp. No id/timestamps/version spread from columns.ts — audit_logs is not a
 * normal tenant table: it is never updated or soft-deleted, and it is PARTITION BY RANGE
 * (occurred_at), which Drizzle's schema builder cannot express, so the partitioning clause and
 * the initial partition are added as raw SQL in the migration (see drizzle/0000_*.sql).
 *
 * Append-only is enforced by revoking UPDATE/DELETE from the application role in the same
 * migration — not by application discipline alone (I3).
 */
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  actorType: text('actor_type').notNull(), // USER | SYSTEM | INTEGRATION | PLATFORM_ADMIN
  action: text('action').notNull(), // e.g. purchase_order.approved
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  changes: jsonb('changes'), // { field: { from, to } } — diff only, not full rows
  metadata: jsonb('metadata'), // ip, user_agent, request_id, reason
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});
