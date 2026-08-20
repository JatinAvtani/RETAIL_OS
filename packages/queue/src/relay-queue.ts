import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const RELAY_QUEUE_NAME = 'outbox-relay';

/**
 * The real payload every relayed job carries — mirrors `outbox_events`' own columns exactly (spec
 * 9.4's literal shape: `aggregate_type, aggregate_id, event_type, payload, organization_id`), so a
 * consumer never needs a second lookup back into `outbox_events` to know what happened. `payload`
 * stays `unknown` here — this queue is a generic transport, not a typed-per-event-type contract;
 * each consumer (e.g. the rule-evaluation processor) narrows it for the event types it actually
 * understands.
 */
export interface RelayJobData {
  outboxEventId: string;
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

/**
 * The real I8 relay (spec 9.4: "a relay process polls unpublished outbox rows and pushes to Redis
 * queues, marking published on success") — this project's first genuine consumer of
 * `outbox_events`, closing the deferral ADR-17 (metric caching) explicitly left open ("no such
 * relay is built yet... a real polling/delivery worker is separate infrastructure"). One shared
 * queue for every event type, not one queue per type — matching the outbox's own design as a
 * single ordered transport; a specific CONSUMER (this epic's rule-evaluation processor) is what
 * narrows by `eventType`, not the queue itself. `jobId: outboxEventId` gives free idempotency: a
 * relay poll that re-enqueues an already-enqueued-but-not-yet-published row (a real race the
 * "mark published AFTER enqueue succeeds" ordering can produce under a crash between the two
 * steps) never creates a duplicate job — BullMQ's own uniqueness guarantee, same precedent
 * `extraction-queue.ts`'s `jobId: documentId` already established.
 */
export const createRelayQueue = (connection: Redis): Queue<RelayJobData> =>
  new Queue<RelayJobData>(RELAY_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
  });

export const enqueueRelayJob = async (queue: Queue<RelayJobData>, data: RelayJobData): Promise<void> => {
  await queue.add('relay', data, { jobId: data.outboxEventId });
};

export const RELAY_POLL_QUEUE_NAME = 'outbox-relay-poll';

/**
 * The "poll" half of "a relay process polls unpublished outbox rows" — a real BullMQ repeatable
 * job, matching `fact-aggregation-queue.ts`'s exact `upsertJobScheduler` precedent (confirmed
 * against BullMQ 6.x's real API, `repeat` was removed from `Queue.add`). `{ every: 15000 }` (15s),
 * not a cron pattern — a relay needs sub-minute latency to be a real notification pipeline (the
 * plan's daily briefing depends on alerts existing well before 06:00 store-local), unlike
 * fact-aggregation's genuinely once-daily cadence. `jobSchedulerId` is a fixed constant
 * (`'outbox-relay'`) since there is exactly ONE relay tick for the whole system, not one per
 * tenant/store — the relay itself is deliberately cross-tenant (see `findUnpublishedOutboxEvents`,
 * `packages/db`), so registering it once at worker startup (idempotent via `upsertJobScheduler`,
 * safe to call on every restart) is the complete scheduling story.
 */
export const createRelayPollQueue = (connection: Redis): Queue =>
  new Queue(RELAY_POLL_QUEUE_NAME, { connection });

export const registerRelayPollJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('outbox-relay', { every: 15000 });
};
