import { and, asc, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';
import { outboxEvents } from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type UnpublishedOutboxEvent = {
  id: string;
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
};

/**
 * The real read side of "a relay process polls unpublished outbox rows" (spec 9.4). Deliberately
 * cross-tenant by nature, same reasoning as `findExpiryQueue`/`findStockLevelDrift`/
 * `findNegativeStock` — a relay is an internal infrastructure sweep across every tenant's events,
 * not a single organization's scoped request. `db` must be an admin-equivalent connection, not a
 * `TenantScopedRepository`, which by construction can only ever see one tenant.
 *
 * `limit` bounds one poll's batch size — a relay tick enqueues at most this many jobs, never
 * unboundedly drains the whole unpublished backlog in one call, so a large accumulated backlog
 * (e.g. after Redis being down for a while, exactly the scenario `outbox_events`' own design
 * absorbs safely) doesn't produce one enormous transaction. Ordered oldest-first (`createdAt`) so
 * relay ordering matches write ordering — not a strict guarantee once concurrent transactions are
 * involved, but the best-effort default this table's own `outbox_events_unpublished_idx`
 * (`organization_id, created_at) WHERE published_at IS NULL`) already supports as an index scan.
 */
export const findUnpublishedOutboxEvents = async (db: Db, limit: number): Promise<UnpublishedOutboxEvent[]> => {
  const rows = await db
    .select()
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
  }));
};

/**
 * Marks a batch of outbox rows published — called ONLY after every corresponding `Queue.add` call
 * has genuinely succeeded (see `apps/worker`'s relay processor), never before. If the process
 * crashes between enqueuing and this call, the row stays unpublished and gets picked up again on
 * the next poll; `RelayJobData`'s `jobId: outboxEventId` (`packages/queue`) makes that re-enqueue
 * a safe no-op via BullMQ's own uniqueness guarantee rather than a duplicate delivery — this is
 * the "at-least-once delivery, every consumer must be idempotent" guarantee spec 9.4 states
 * explicitly, made real at this exact seam.
 */
export const markOutboxEventsPublished = async (db: Db, ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  await db
    .update(outboxEvents)
    .set({ publishedAt: new Date() })
    .where(and(inArray(outboxEvents.id, ids), isNull(outboxEvents.publishedAt)));
};
