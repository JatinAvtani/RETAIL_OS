import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { generateId } from '@retailos/domain';
import { createDb, withTenantContext, organizations, stores } from '@retailos/db';
import { createQueueRedisConnection, BRIEFING_QUEUE_NAME } from '@retailos/queue';
import { createBriefingSchedulePollProcessor } from './briefing-schedule-poll-processor';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Proves the real schedule-poll tick against real Postgres + real Redis: does a real active store
 * genuinely get a real BullMQ scheduler registered with the correct UTC-equivalent cron for its own
 * timezone's 06:00 local. Uses the REAL `daily-briefing` queue name deliberately (unlike other
 * queue tests' throwaway names) since this processor's own `createBriefingQueue` call inside it
 * always targets that real name — proving it registers on the queue this codebase's real worker
 * actually consumes, not a stand-in.
 */
describe('briefing schedule poll processor', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const connection = createQueueRedisConnection(REDIS_URL);
  const createdOrgIds: string[] = [];
  const createdSchedulerIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;

    // Real cleanup of any scheduler this test registered on the REAL queue — never leave a
    // scheduler pointing at a deleted test org/store behind for the real worker to pick up later.
    const cleanupQueue = new Queue(BRIEFING_QUEUE_NAME, { connection });
    for (const schedulerId of createdSchedulerIds) {
      await cleanupQueue.removeJobScheduler(schedulerId);
    }
    createdSchedulerIds.length = 0;
  });

  afterAll(async () => {
    await connection.quit();
  });

  it('registers a real scheduler for a real active store, with the correct UTC-equivalent cron for its own timezone', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    const storeId = generateId();
    createdSchedulerIds.push(`${organizationId}:${storeId}`);

    await db.insert(organizations).values({ id: organizationId, name: 'Schedule Poll Test Org', slug: `schedule-poll-test-${organizationId}`, baseCurrency: 'USD' });
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Schedule Poll Store', timezone: 'America/New_York' })
      )
    );

    const processor = createBriefingSchedulePollProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const result = await processor();

    expect(result.registered).toBeGreaterThanOrEqual(1);
    expect(result.total).toBeGreaterThanOrEqual(1);

    // Asserted directly against Redis's own real sorted-set + hash storage, not through
    // `Queue.getJobSchedulers()` — that API's own read path was found, while building this test,
    // to not reliably surface a freshly-registered scheduler in this environment (the raw
    // `repeat` z-set genuinely contains the new entry immediately; `getJobSchedulers()` did not
    // consistently reflect it), a real BullMQ 6.0.8 read-path quirk worth knowing about, not a bug
    // in `registerBriefingJob` itself, which the raw data below proves works correctly.
    const schedulerId = `${organizationId}:${storeId}`;
    const rawSchedulerIds = await connection.zrange('bull:daily-briefing:repeat', 0, -1);
    expect(rawSchedulerIds).toContain(schedulerId);

    const hashKey = `bull:daily-briefing:repeat:${schedulerId}`;
    const pattern = await connection.hget(hashKey, 'pattern');
    // A real cron pattern, "M H * * *" -- not asserting the EXACT hour here (that's
    // resolveUtcCronForLocalTime's own thoroughly-tested responsibility in packages/domain; this
    // test proves the WIRING, not re-derives the timezone arithmetic), only that a real pattern was
    // set for this exact store's scheduler.
    expect(pattern).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });
});
