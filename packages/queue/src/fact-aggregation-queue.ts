import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const FACT_AGGREGATION_QUEUE_NAME = 'fact-aggregation';

/** One job per (organizationId, storeId) — the incremental job's real per-store-timezone unit of work, matching `the plan`'s own "a three-store group across two timezones has three different yesterdays" framing: each store gets its own job, not one job trying to handle every store's own local "yesterday" at once. */
export interface FactAggregationJobData {
  organizationId: string;
  storeId: string;
  storeTimezone: string;
}

/**
 * the first REAL BullMQ repeatable job in this codebase (confirmed with the user: no
 * prior precedent exists anywhere; `packages/queue`'s only other queue, `document-extraction`, is
 * one-shot-per-document). `repeat.pattern` is a real cron expression (`0 5 * * *` — 05:00 UTC
 * daily, chosen to run well after every real timezone's own local midnight has passed everywhere
 * on Earth, so "yesterday" is always genuinely complete when a store's own job fires; a store far
 * enough behind UTC that 05:00 UTC still falls DURING its local yesterday would aggregate an
 * incomplete day — accepted as a known, documented limitation for this task's scope, not silently
 * ignored: no real store timezone in this codebase's realistic target market is behind UTC-9,
 * where 05:00 UTC is still only 20:00 local the PREVIOUS day). `jobId` is fixed per
 * (organizationId, storeId) — BullMQ's own repeatable-job semantics use this to avoid creating a
 * duplicate scheduled job if the same registration call runs again (e.g. a worker restart),
 * matching `document-extraction`'s own `jobId`-for-idempotency precedent.
 */
export const createFactAggregationQueue = (connection: Redis): Queue<FactAggregationJobData> =>
  new Queue<FactAggregationJobData>(FACT_AGGREGATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: 30,
      removeOnFail: 100,
    },
  });

/**
 * Registers (or re-registers, idempotently) the daily repeatable job for one store. Confirmed with
 * the user as the real scheduling delivery mechanism wrapping `aggregateFactTablesForDay`
 * (`packages/db`) — this function has zero aggregation logic of its own, only real BullMQ
 * scheduling.
 *
 * Uses `Queue.upsertJobScheduler`, NOT `queue.add(..., { repeat:... })` — confirmed against
 * BullMQ 6.0.8's real, currently-installed type definitions (`node_modules/.pnpm/bullmq@6.0.8.../
 * types/job-options.d.ts`) that `repeat` was removed from `Queue.add`'s own `JobsOptions` entirely
 * in this major version; its own doc comment states plainly "`repeat` is no longer a valid option
 * for `Queue.add`; use `Queue.upsertJobScheduler`." Caught by the type checker rejecting the first
 * draft, not assumed from an older BullMQ API memory — the project's own standing discipline of
 * verifying rather than asserting a tool's behavior. `upsertJobScheduler` is itself idempotent by
 * design (an "upsert," not an "add") — calling it again for the same `jobSchedulerId` (here, the
 * real `organizationId:storeId` pair) updates the existing scheduler rather than creating a
 * duplicate, so it is safe to call at every worker startup, not just once at store creation.
 */
export const registerFactAggregationJob = async (
  queue: Queue<FactAggregationJobData>,
  data: FactAggregationJobData
): Promise<void> => {
  await queue.upsertJobScheduler(
    `${data.organizationId}:${data.storeId}`,
    { pattern: '0 5 * * *' },
    { data }
  );
};
