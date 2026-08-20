import { createDb, findUnpublishedOutboxEvents, markOutboxEventsPublished } from '@retailos/db';
import { createQueueRedisConnection, createRelayQueue, enqueueRelayJob, type RelayJobData } from '@retailos/queue';

const POLL_BATCH_SIZE = 100;

/**
 * The real "poll unpublished outbox rows and push to Redis, marking published on success" half of
 * spec 9.4's relay — this project's I8 closure. `db` is the ADMIN-equivalent connection
 * (`config.databaseUrl`, same convention `fact-aggregation-processor.ts` already uses), since a
 * relay tick sweeps every tenant's unpublished events in one poll — `findUnpublishedOutboxEvents`
 * (`packages/db`) is deliberately cross-tenant, matching `findExpiryQueue`'s own precedent.
 *
 * Enqueue-THEN-mark-published, never the reverse: if the process crashes between the two, the row
 * stays unpublished and gets picked up again next tick — `RelayJobData`'s `jobId: outboxEventId`
 * (`packages/queue`) makes that re-enqueue a safe no-op via BullMQ's own uniqueness guarantee, not
 * a duplicate delivery. Marking-then-enqueueing would risk the opposite failure — a row marked
 * published that was never actually enqueued, silently lost forever, which is exactly the failure
 * class the whole outbox design exists to prevent (spec 9.4: "stock updates, event never fires, no
 * alert generated... and nothing looks broken").
 *
 * Each tick's own enqueue failures are collected, not allowed to abort the whole batch — one
 * malformed/oversized event shouldn't block every other genuine event in the same poll from being
 * relayed. Only the events that genuinely enqueued get marked published.
 */
export const createRelayPollProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);
  const relayQueue = createRelayQueue(createQueueRedisConnection(config.redisUrl));

  return async (): Promise<{ relayed: number; total: number }> => {
    const unpublished = await findUnpublishedOutboxEvents(db, POLL_BATCH_SIZE);
    const relayedIds: string[] = [];

    for (const event of unpublished) {
      const jobData: RelayJobData = {
        outboxEventId: event.id,
        organizationId: event.organizationId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
      };
      try {
        await enqueueRelayJob(relayQueue, jobData);
        relayedIds.push(event.id);
      } catch (error) {
        // Left unpublished on purpose — the next tick retries it. A single malformed/oversized
        // event (or a transient Redis error mid-batch) must not abort every other genuine event
        // already enqueued successfully in this same tick.
        console.error(`Outbox relay: failed to enqueue event ${event.id} (${event.eventType})`, error);
      }
    }

    await markOutboxEventsPublished(db, relayedIds);
    return { relayed: relayedIds.length, total: unpublished.length };
  };
};
