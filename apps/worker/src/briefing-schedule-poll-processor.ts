import { createDb, findActiveStoresForScheduling } from '@retailos/db';
import { resolveUtcCronForLocalTime } from '@retailos/domain';
import { createQueueRedisConnection, createBriefingQueue, registerBriefingJob } from '@retailos/queue';

/**
 * The real "poll" half of genuine per-store-timezone scheduling — see
 * `packages/queue/src/briefing-queue.ts`'s own header for the full reasoning on why this re-derives
 * every tick rather than registering once. For every active store, computes today's real
 * UTC-equivalent cron time for "06:00 local" and re-registers that store's own briefing scheduler —
 * a store whose timezone just crossed a DST boundary gets corrected within one tick (hourly).
 */
export const createBriefingSchedulePollProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);
  const briefingQueue = createBriefingQueue(createQueueRedisConnection(config.redisUrl));

  return async (): Promise<{ registered: number; total: number }> => {
    const stores = await findActiveStoresForScheduling(db);
    const now = new Date();
    let registered = 0;

    for (const store of stores) {
      try {
        const cron = resolveUtcCronForLocalTime(now, store.timezone, 6, 0);
        await registerBriefingJob(briefingQueue, { organizationId: store.organizationId, storeId: store.storeId }, cron);
        registered += 1;
      } catch (error) {
        // A single store's own timezone value being malformed/unrecognized must not abort every
        // other store's real, correctly-configured schedule in the same tick.
        console.error(`Briefing schedule poll: failed to register store ${store.storeId}`, error);
      }
    }

    return { registered, total: stores.length };
  };
};
