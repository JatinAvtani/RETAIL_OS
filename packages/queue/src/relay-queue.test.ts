import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { createQueueRedisConnection } from './connection';
import { enqueueRelayJob, registerRelayPollJob, type RelayJobData } from './relay-queue';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Proves the real BullMQ mechanics of the outbox relay queue against real Redis (docker-compose.yml)
 * — matching `extraction-queue.test.ts`'s established precedent: a mock queue would only prove this
 * project's own code calls `.add()` correctly, not that a job genuinely round-trips through Redis.
 * Each test uses its OWN queue name (the "two tests racing on one shared queue" gotcha this
 * codebase already learned once) rather than the real `outbox-relay`/`outbox-relay-poll` names.
 */
describe('relay queue (real BullMQ + real Redis)', () => {
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

  it('a job enqueued via enqueueRelayJob is genuinely picked up and processed by a real Worker', async () => {
    const queueName = `test-relay-${Date.now()}-a`;
    const queue = new Queue<RelayJobData>(queueName, { connection, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 } } });
    createdQueues.push(queue);
    const processed: RelayJobData[] = [];

    const worker = new Worker<RelayJobData>(
      queueName,
      async (job) => {
        processed.push(job.data);
      },
      { connection }
    );
    createdWorkers.push(worker);

    const jobData: RelayJobData = {
      outboxEventId: 'event-1',
      organizationId: 'org-1',
      aggregateType: 'stock_movement',
      aggregateId: 'movement-1',
      eventType: 'stock.moved',
      payload: { storeId: 'store-1', productId: 'product-1', variantId: 'variant-1' },
    };
    await enqueueRelayJob(queue, jobData);

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

  it('enqueueRelayJob uses outboxEventId as the jobId — a re-enqueue for the same event is a genuine no-op, not a duplicate job', async () => {
    const queueName = `test-relay-${Date.now()}-b`;
    const queue = new Queue<RelayJobData>(queueName, { connection });
    createdQueues.push(queue);

    const jobData: RelayJobData = {
      outboxEventId: 'event-idempotent',
      organizationId: 'org-1',
      aggregateType: 'purchase_order',
      aggregateId: 'po-1',
      eventType: 'po.created',
      payload: {},
    };

    await enqueueRelayJob(queue, jobData);
    const firstJob = await queue.getJob('event-idempotent');
    expect(firstJob).toBeTruthy();

    // This is the real property that makes the relay-poll processor's "crash between enqueue and
    // mark-published, re-poll picks the same row up again" recovery path safe — proven directly
    // against real Redis, not assumed from BullMQ's docs.
    await enqueueRelayJob(queue, jobData);
    const secondJob = await queue.getJob('event-idempotent');
    expect(secondJob?.id).toBe(firstJob?.id);

    const jobCounts = await queue.getJobCounts();
    const totalJobs = Object.values(jobCounts).reduce((a, b) => a + b, 0);
    expect(totalJobs).toBe(1);
  });

  it('registerRelayPollJob creates a real repeatable job scheduler against real Redis', async () => {
    const queueName = `test-relay-poll-${Date.now()}`;
    const queue = new Queue(queueName, { connection });
    createdQueues.push(queue);

    await registerRelayPollJob(queue);
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]?.every).toBe(15000);
  });

  it('registerRelayPollJob is idempotent — calling it twice does not create a second scheduler', async () => {
    const queueName = `test-relay-poll-idempotent-${Date.now()}`;
    const queue = new Queue(queueName, { connection });
    createdQueues.push(queue);

    await registerRelayPollJob(queue);
    await registerRelayPollJob(queue);
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
  });
});
