import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const BRIEFING_QUEUE_NAME = 'daily-briefing';

/** One job per store, fired at that store's own real 06:00-local UTC-equivalent instant. */
export interface BriefingJobData {
  organizationId: string;
  storeId: string;
}

/**
 * "06:00 store-local (scheduled per tenant timezone)" — the daily-briefing generation job itself.
 * `attempts`/`backoff` retry a transient failure (a metric read hitting a momentary DB hiccup, a
 * live Gemini narration call failing) a few times before giving up for that day; a briefing that
 * genuinely can't be generated today is not retried forever into tomorrow's own separate run.
 */
export const createBriefingQueue = (connection: Redis): Queue<BriefingJobData> =>
  new Queue<BriefingJobData>(BRIEFING_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: 30,
      removeOnFail: 100,
    },
  });

export const BRIEFING_SCHEDULE_POLL_QUEUE_NAME = 'daily-briefing-schedule-poll';

/**
 * The genuinely per-store-timezone scheduling mechanism, confirmed with the user over
 * fact-aggregation's own simpler fixed-UTC-cron precedent (05:00 UTC for every store, an accepted
 * approximation for a less time-sensitive deadline) — the briefing plan explicitly names "briefing
 * at wrong local time" as a real risk, a stricter requirement.
 *
 * A single repeatable "registration tick" (this queue, hourly — frequent enough that a DST
 * transition, which can only ever land on an hour boundary, is corrected within an hour of taking
 * effect, cheap enough that re-registering every store's scheduler every tick is negligible load)
 * re-derives EVERY active store's real UTC-equivalent cron time for "06:00 local, right now" via
 * `resolveUtcCronForLocalTime` (`packages/domain`) and calls `upsertJobScheduler` for each — safe
 * to call every tick because `upsertJobScheduler` is itself idempotent (same `jobSchedulerId`
 * updates the existing scheduler's pattern rather than creating a duplicate), matching
 * `registerFactAggregationJob`'s own "safe to call at every worker startup" precedent, just on a
 * recurring tick instead of once at store-creation time — this is what makes the schedule
 * self-correct across a DST transition rather than drifting an hour twice a year, which a single
 * fixed-at-creation-time cron pattern could never do.
 */
export const createBriefingSchedulePollQueue = (connection: Redis): Queue =>
  new Queue(BRIEFING_SCHEDULE_POLL_QUEUE_NAME, { connection });

export const registerBriefingSchedulePollJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('daily-briefing-schedule-poll', { every: 60 * 60 * 1000 });
};

/**
 * Registers (or re-registers, idempotently) ONE store's real daily briefing job at its genuine
 * UTC-equivalent cron time for 06:00 local. `jobSchedulerId` is fixed per (organizationId,
 * storeId) — the same store re-registered on every poll tick updates its existing scheduler's
 * pattern (correcting for DST) rather than creating a second one, matching
 * `registerFactAggregationJob`'s exact idempotency shape.
 */
export const registerBriefingJob = async (
  queue: Queue<BriefingJobData>,
  data: BriefingJobData,
  cron: { hour: number; minute: number }
): Promise<void> => {
  await queue.upsertJobScheduler(
    `${data.organizationId}:${data.storeId}`,
    { pattern: `${cron.minute} ${cron.hour} * * *` },
    { data }
  );
};
