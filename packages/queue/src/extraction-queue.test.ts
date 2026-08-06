import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { createQueueRedisConnection } from './connection';
import { enqueueExtractionJob, type ExtractionJobData } from './extraction-queue';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * 007-05: proves the real BullMQ mechanics against real Redis (docker-compose.yml) — a mock queue
 * would only prove this project's own code calls `.add()`/constructs a `Worker` correctly, not that
 * a job genuinely round-trips through Redis and gets picked up. Each test uses its OWN queue name
 * (not the real `document-extraction` name `createExtractionQueue` hardcodes) — found the hard way
 * this session: two tests sharing one real queue name let the first test's still-open `Worker`
 * (subscribed before `afterEach` closes it) race to pick up the SECOND test's job, since Redis
 * doesn't know or care which `it()` block a job "belongs to". A fresh `Queue`/`Worker` pair per
 * test, built with `defaultJobOptions` matching `createExtractionQueue`'s real shape, avoids this
 * without needing artificial serialization between tests.
 */
describe('extraction queue (real BullMQ + real Redis)', () => {
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

  it('a job enqueued via enqueueExtractionJob is genuinely picked up and processed by a real Worker', async () => {
    const queueName = `test-extraction-${Date.now()}-a`;
    const queue = new Queue<ExtractionJobData>(queueName, { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } });
    createdQueues.push(queue);
    const processed: ExtractionJobData[] = [];

    const worker = new Worker<ExtractionJobData>(
      queueName,
      async (job) => {
        processed.push(job.data);
      },
      { connection }
    );
    createdWorkers.push(worker);

    const jobData: ExtractionJobData = {
      documentId: 'doc-1',
      organizationId: 'org-1',
      storageKey: 'org/org-1/documents/doc-1.pdf',
      mimeType: 'application/pdf',
    };
    await enqueueExtractionJob(queue, jobData);

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

  it('enqueueExtractionJob uses documentId as the jobId, making a duplicate enqueue for the same document a no-op', async () => {
    const queueName = `test-extraction-${Date.now()}-b`;
    const queue = new Queue<ExtractionJobData>(queueName, { connection });
    createdQueues.push(queue);

    const jobData: ExtractionJobData = {
      documentId: 'doc-idempotent',
      organizationId: 'org-1',
      storageKey: 'org/org-1/documents/doc-idempotent.pdf',
      mimeType: 'application/pdf',
    };

    await enqueueExtractionJob(queue, jobData);
    const firstJob = await queue.getJob('doc-idempotent');
    expect(firstJob).toBeTruthy();

    // A second enqueue for the same documentId must not create a second job — BullMQ's own
    // jobId-uniqueness guarantee, proven directly rather than assumed from the library's docs.
    await enqueueExtractionJob(queue, jobData);
    const secondJob = await queue.getJob('doc-idempotent');
    expect(secondJob?.id).toBe(firstJob?.id);
    expect(secondJob?.timestamp).toBe(firstJob?.timestamp);

    const jobCounts = await queue.getJobCounts();
    const totalJobs = Object.values(jobCounts).reduce((a, b) => a + b, 0);
    expect(totalJobs).toBe(1);
  });
});
