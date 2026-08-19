import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const EMBEDDING_QUEUE_NAME = 'document-embedding';

export interface EmbeddingJobData {
  documentId: string;
  organizationId: string;
}

/**
 * one job per document needing (re-)embedding, matching `extraction-queue.ts`'s exact
 * one-shot-per-document shape. Enqueued when a document reaches `APPROVED` (confirmed with the
 * user) — approved extracted fields are trustworthy enough to build a real, searchable description
 * from; a `REVIEW_REQUIRED` document's fields haven't been human-confirmed yet, so embedding it
 * would make an unverified guess searchable as if it were fact. `jobId: documentId` makes
 * re-approval (a corrected extraction) idempotently replace the pending job rather than queueing a
 * duplicate.
 */
export const createEmbeddingQueue = (connection: Redis): Queue<EmbeddingJobData> =>
  new Queue<EmbeddingJobData>(EMBEDDING_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

export const enqueueEmbeddingJob = async (queue: Queue<EmbeddingJobData>, data: EmbeddingJobData): Promise<void> => {
  await queue.add('embed', data, { jobId: data.documentId });
};
