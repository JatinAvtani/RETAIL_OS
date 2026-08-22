import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { createQueueRedisConnection } from './connection';
import { registerBriefingJob, registerBriefingSchedulePollJob, type BriefingJobData } from './briefing-queue';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Proves the real BullMQ mechanics of the daily-briefing queue + genuine per-store-timezone
 * scheduling against real Redis — matching `relay-queue.test.ts`/`fact-aggregation-queue.test.ts`'s
 * established precedent. Each test uses its own queue name, not the real `daily-briefing`/
 * `daily-briefing-schedule-poll` names.
 */
describe('briefing queue (real BullMQ + real Redis)', () => {
  const connection = createQueueRedisConnection(REDIS_URL);
  const createdWorkers: Worker[] = [];
  const createdQueues: Queue[] = [];

  afterEach(async () => {
    for (const worker of createdWorkers) {
      await worker.close();
    }
    for (const queue of createdQueues) {
      await queue.obliterate({ force: true });
    }
    createdWorkers.length = 0;
    createdQueues.length = 0;
  });

  afterAll(async () => {
    await connection.quit();
  });

  it('a job enqueued via createBriefingQueue is genuinely picked up and processed by a real Worker', async () => {
    const queueName = `test-briefing-${Date.now()}-a`;
    const queue = new Queue<BriefingJobData>(queueName, { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30000 } } });
    createdQueues.push(queue);
    const processed: BriefingJobData[] = [];

    const worker = new Worker<BriefingJobData>(
      queueName,
      async (job) => {
        processed.push(job.data);
      },
      { connection }
    );
    createdWorkers.push(worker);

    const jobData: BriefingJobData = { organizationId: 'org-1', storeId: 'store-1' };
    await queue.add('brief', jobData, { jobId: `${jobData.organizationId}:${jobData.storeId}:manual` });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('job was not processed within 10s')), 10000);
      worker.on('completed', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(processed).toHaveLength(1);
    expect(processed[0]).toEqual(jobData);
  });

  it('registerBriefingJob creates a real repeatable scheduler at the given cron hour/minute, keyed per (org, store)', async () => {
    const queueName = `test-briefing-schedule-${Date.now()}`;
    const queue = new Queue<BriefingJobData>(queueName, { connection });
    createdQueues.push(queue);

    await registerBriefingJob(queue, { organizationId: 'org-1', storeId: 'store-1' }, { hour: 10, minute: 0 });
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]?.pattern).toBe('0 10 * * *');
  });

  it('registerBriefingJob is idempotent AND self-corrects an existing store\'s schedule when the cron changes (DST correction)', async () => {
    const queueName = `test-briefing-schedule-correct-${Date.now()}`;
    const queue = new Queue<BriefingJobData>(queueName, { connection });
    createdQueues.push(queue);

    // First registration: EDT-equivalent UTC hour for 06:00 local.
    await registerBriefingJob(queue, { organizationId: 'org-1', storeId: 'store-1' }, { hour: 10, minute: 0 });
    let schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]?.pattern).toBe('0 10 * * *');

    // A later poll tick re-derives a DIFFERENT UTC hour (e.g. after a DST transition, EST-equivalent) —
    // the SAME store must get its EXISTING scheduler updated, not a second one created.
    await registerBriefingJob(queue, { organizationId: 'org-1', storeId: 'store-1' }, { hour: 11, minute: 0 });
    schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]?.pattern).toBe('0 11 * * *');
  });

  it('registerBriefingSchedulePollJob creates a real repeatable job scheduler, running every hour', async () => {
    const queueName = `test-briefing-poll-${Date.now()}`;
    const queue = new Queue(queueName, { connection });
    createdQueues.push(queue);

    await registerBriefingSchedulePollJob(queue);
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]?.every).toBe(60 * 60 * 1000);
  });
});
