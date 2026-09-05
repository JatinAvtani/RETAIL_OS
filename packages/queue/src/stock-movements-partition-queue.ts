import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const STOCK_MOVEMENTS_PARTITION_QUEUE_NAME = 'stock-movements-partition-maintenance';

/**
 * The real repeatable "keep the next few months of `stock_movements` partitions pre-created" job —
 * closes the gap `0014_stock_movements.sql`'s own header names explicitly ("an operational job
 * this migration seeds the first instance of"). A pure "tick" job with no meaningful per-invocation
 * `job.data` of its own, matching `RELAY_POLL_QUEUE_NAME`/`BRIEFING_SCHEDULE_POLL_QUEUE_NAME`'s own
 * shape — it always sweeps/ensures the same fixed month-ahead window, never a per-tenant or
 * per-entity parameter.
 *
 * `{ pattern: '0 3 * * *' }` (03:00 UTC daily) at registration time, not `{ every }` — this is a
 * calendar-month concern (like fact-aggregation's own daily cron), not a sub-minute-latency
 * concern like the outbox relay poll; once a day is more than enough headroom against
 * `DEFAULT_MONTHS_AHEAD`'s multi-month buffer.
 */
export const createStockMovementsPartitionQueue = (connection: Redis): Queue =>
  new Queue(STOCK_MOVEMENTS_PARTITION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: 30,
      removeOnFail: 100,
    },
  });

/**
 * Registers (or re-registers, idempotently) the one system-wide partition-maintenance schedule —
 * matching `registerRelayPollJob`'s exact "fixed `jobSchedulerId`, safe to call on every worker
 * startup" precedent, since there is exactly one of these for the whole system, not one per
 * tenant/store.
 */
export const registerStockMovementsPartitionJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('stock-movements-partition-maintenance', { pattern: '0 3 * * *' });
};
