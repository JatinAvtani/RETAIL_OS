import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { createQueueRedisConnection } from './connection';
import { enqueueNotificationDeliveryJob, type NotificationDeliveryJobData } from './notification-delivery-queue';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Proves the real BullMQ mechanics of the notification-delivery queue against real Redis —
 * matching `relay-queue.test.ts`'s established precedent. Each test uses its own queue name, not
 * the real `notification-delivery` name (the "two tests racing on one shared queue" gotcha).
 */
describe('notification delivery queue (real BullMQ + real Redis)', () => {
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

  it('a job enqueued via enqueueNotificationDeliveryJob is genuinely picked up and processed by a real Worker', async () => {
    const queueName = `test-notification-delivery-${Date.now()}-a`;
    const queue = new Queue<NotificationDeliveryJobData>(queueName, { connection, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 } } });
    createdQueues.push(queue);
    const processed: NotificationDeliveryJobData[] = [];

    const worker = new Worker<NotificationDeliveryJobData>(
      queueName,
      async (job) => {
        processed.push(job.data);
      },
      { connection }
    );
    createdWorkers.push(worker);

    const jobData: NotificationDeliveryJobData = { deliveryId: 'delivery-1', organizationId: 'org-1' };
    await enqueueNotificationDeliveryJob(queue, jobData);

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

  it('enqueueNotificationDeliveryJob uses deliveryId as the jobId — a re-enqueue for the same delivery is a genuine no-op, not a duplicate job', async () => {
    const queueName = `test-notification-delivery-${Date.now()}-b`;
    const queue = new Queue<NotificationDeliveryJobData>(queueName, { connection });
    createdQueues.push(queue);

    const jobData: NotificationDeliveryJobData = { deliveryId: 'delivery-idempotent', organizationId: 'org-1' };

    await enqueueNotificationDeliveryJob(queue, jobData);
    const firstJob = await queue.getJob('delivery-idempotent');
    expect(firstJob).toBeTruthy();

    await enqueueNotificationDeliveryJob(queue, jobData);
    const secondJob = await queue.getJob('delivery-idempotent');
    expect(secondJob?.id).toBe(firstJob?.id);

    const jobCounts = await queue.getJobCounts();
    const totalJobs = Object.values(jobCounts).reduce((a, b) => a + b, 0);
    expect(totalJobs).toBe(1);
  });

  it('a job retries with real backoff on failure — attemptsMade advances toward the configured attempts budget', async () => {
    const queueName = `test-notification-delivery-${Date.now()}-c`;
    const queue = new Queue<NotificationDeliveryJobData>(queueName, {
      connection,
      defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 200 } },
    });
    createdQueues.push(queue);

    let attemptCount = 0;
    const worker = new Worker<NotificationDeliveryJobData>(
      queueName,
      async () => {
        attemptCount += 1;
        throw new Error('simulated transient failure');
      },
      { connection }
    );
    createdWorkers.push(worker);

    await queue.add('deliver', { deliveryId: 'delivery-retry', organizationId: 'org-1' }, { jobId: 'delivery-retry' });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('job did not reach final failure within 10s')), 10000);
      worker.on('failed', (job) => {
        if (job && job.attemptsMade >= 2) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    expect(attemptCount).toBe(2);
  });
});
