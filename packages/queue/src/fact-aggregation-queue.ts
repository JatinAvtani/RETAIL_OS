import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const FACT_AGGREGATION_QUEUE_NAME = 'fact-aggregation';

/** One job per (organizationId, storeId) — the incremental job's real per-store-timezone unit of work: a three-store group across two timezones has three different yesterdays, so each store gets its own job, not one job trying to handle every store's own local "yesterday" at once. */
export interface FactAggregationJobData {
  organizationId: string;
  storeId: string;
  storeTimezone: string;
}

/**
 * the first REAL BullMQ repeatable job in this codebase — no
 * prior precedent exists anywhere; `packages/queue`'s only other queue, `document-extraction`, is
 * one-shot-per-document. Originally fired every store at a single fixed `0 5 * * *` (05:00 UTC),
 * accepted as a known limitation for any timezone behind UTC-9. Now registered per-store at a real
 * UTC-equivalent cron time via `fact-aggregation-schedule-poll-processor.ts` (the same
 * `resolveUtcCronForLocalTime` + hourly re-registration pattern `briefing-queue.ts` already
 * established), so "yesterday" is genuinely complete in every timezone before the job fires.
 * `jobId` is fixed per (organizationId, storeId) — BullMQ's own repeatable-job semantics use this
 * to avoid creating a duplicate scheduled job if the same registration call runs again (e.g. a
 * worker restart or the hourly poll tick), matching `document-extraction`'s own
 * `jobId`-for-idempotency precedent.
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
 * Registers (or re-registers, idempotently) the daily repeatable job for one store, at a real
 * per-store-timezone cron time rather than the fixed `0 5 * * *` this function used before —
 * matching `registerBriefingJob`'s exact idempotency shape (`upsertJobScheduler` keyed by
 * `organizationId:storeId`, safe to call every tick). Confirmed with the user as the real
 * scheduling delivery mechanism wrapping `aggregateFactTablesForDay` (`packages/db`) — this
 * function has zero aggregation logic of its own, only real BullMQ scheduling.
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
  data: FactAggregationJobData,
  cron: { hour: number; minute: number }
): Promise<void> => {
  await queue.upsertJobScheduler(
    `${data.organizationId}:${data.storeId}`,
    { pattern: `${cron.minute} ${cron.hour} * * *` },
    { data }
  );
};

export const FACT_AGGREGATION_SCHEDULE_POLL_QUEUE_NAME = 'fact-aggregation-schedule-poll';

/**
 * The per-store-timezone scheduling mechanism for fact aggregation — same shape as
 * `createBriefingSchedulePollQueue`/`registerBriefingSchedulePollJob`. A single repeatable
 * "registration tick" (hourly) re-derives every active store's real UTC-equivalent cron time and
 * calls `registerFactAggregationJob` for each, so a store's schedule self-corrects across a DST
 * transition instead of drifting, and no store's job can fire before its own local day is over.
 */
export const createFactAggregationSchedulePollQueue = (connection: Redis): Queue =>
  new Queue(FACT_AGGREGATION_SCHEDULE_POLL_QUEUE_NAME, { connection });

export const registerFactAggregationSchedulePollJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('fact-aggregation-schedule-poll', { every: 60 * 60 * 1000 });
};
