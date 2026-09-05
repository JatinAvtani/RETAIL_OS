import { createDb, findActiveStoresForScheduling } from '@retailos/db';
import { resolveUtcCronForLocalTime, type StoreTimezone } from '@retailos/domain';
import { createQueueRedisConnection, createFactAggregationQueue, registerFactAggregationJob } from '@retailos/queue';

/**
 * The real per-store-timezone scheduling mechanism for fact aggregation, replacing the previous
 * fixed `0 5 * * *` (05:00 UTC for every store) — see `fact-aggregation-queue.ts`'s own header.
 * For every active store, computes today's real UTC-equivalent cron time for "01:00 local" (one
 * hour past local midnight — a small buffer for last-minute POS syncs to land before the store's
 * own "yesterday" is aggregated) and re-registers that store's own scheduler, matching
 * `createBriefingSchedulePollProcessor`'s exact shape.
 */
export const createFactAggregationSchedulePollProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);
  const factAggregationQueue = createFactAggregationQueue(createQueueRedisConnection(config.redisUrl));

  return async (): Promise<{ registered: number; total: number }> => {
    const stores = await findActiveStoresForScheduling(db);
    const now = new Date();
    let registered = 0;

    for (const store of stores) {
      try {
        const cron = resolveUtcCronForLocalTime(now, store.timezone as StoreTimezone, 1, 0);
        await registerFactAggregationJob(
          factAggregationQueue,
          { organizationId: store.organizationId, storeId: store.storeId, storeTimezone: store.timezone },
          cron
        );
        registered += 1;
      } catch (error) {
        // A single store's own timezone value being malformed/unrecognized must not abort every
        // other store's real, correctly-configured schedule in the same tick.
        console.error(`Fact aggregation schedule poll: failed to register store ${store.storeId}`, error);
      }
    }

    return { registered, total: stores.length };
  };
};
