import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { createQueueRedisConnection } from './connection';
import { enqueueSquareSyncJob, type SquareSyncJobData } from './square-sync-queue';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Real BullMQ + real Redis, matching extraction-queue.test.ts's own established precedent (a mock
 * queue would only prove this project's own code calls `.add()` correctly, not that a job genuinely
 * round-trips through Redis). Each test uses its own queue name for the same reason documented
 * there — a shared real queue name lets one test's still-open Worker race to pick up another test's
 * job.
 */
describe('square sync queue (real BullMQ + real Redis)', () => {
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

  it('a job enqueued via enqueueSquareSyncJob is genuinely picked up and processed by a real Worker', async () => {
    const queueName = `test-square-sync-${Date.now()}-a`;
    const queue = new Queue<SquareSyncJobData>(queueName, { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } });
    createdQueues.push(queue);
    const processed: SquareSyncJobData[] = [];

    const worker = new Worker<SquareSyncJobData>(
      queueName,
      async (job) => {
        processed.push(job.data);
      },
      { connection }
    );
    createdWorkers.push(worker);

    const jobData: SquareSyncJobData = { kind: 'catalog', organizationId: 'org-1', storeId: 'store-1' };
    await enqueueSquareSyncJob(queue, jobData);

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

  it('two enqueues for the SAME store — one webhook-triggered, one manual — are both real, separate jobs, never deduplicated', async () => {
    // Deliberately the OPPOSITE precedent of extraction-queue.test.ts's own idempotency test: a
    // fixed jobId would silently drop a genuinely distinct sync attempt (see square-sync-queue.ts's
    // own doc comment for why that would be wrong here).
    const queueName = `test-square-sync-${Date.now()}-b`;
    const queue = new Queue<SquareSyncJobData>(queueName, { connection });
    createdQueues.push(queue);

    const jobData: SquareSyncJobData = { kind: 'orders', organizationId: 'org-1', storeId: 'store-1' };
    await enqueueSquareSyncJob(queue, jobData);
    await enqueueSquareSyncJob(queue, jobData);

    const jobCounts = await queue.getJobCounts();
    const totalJobs = Object.values(jobCounts).reduce((a, b) => a + b, 0);
    expect(totalJobs).toBe(2);
  });

  it('each SquareSyncKind is a real, distinct job name', async () => {
    const queueName = `test-square-sync-${Date.now()}-c`;
    const queue = new Queue<SquareSyncJobData>(queueName, { connection });
    createdQueues.push(queue);

    await enqueueSquareSyncJob(queue, { kind: 'catalog', organizationId: 'org-1', storeId: 'store-1' });
    await enqueueSquareSyncJob(queue, { kind: 'orders', organizationId: 'org-1', storeId: 'store-1' });
    await enqueueSquareSyncJob(queue, { kind: 'reconcile', organizationId: 'org-1', storeId: 'store-1' });

    const waiting = await queue.getJobs(['waiting', 'delayed']);
    expect(waiting.map((j) => j.name).sort()).toEqual(['catalog', 'orders', 'reconcile']);
  });
});
