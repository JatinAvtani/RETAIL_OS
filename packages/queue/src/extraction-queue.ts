import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const EXTRACTION_QUEUE_NAME = 'document-extraction';

export interface ExtractionJobData {
  documentId: string;
  organizationId: string;
  storageKey: string;
  mimeType: string;
}

/**
 * 007-05: one job per document needing extraction. `attempts`/`backoff` retry a transient Gemini
 * failure (rate limit, timeout, a 5xx) a few times before giving up — a job that keeps failing
 * after real retries is a genuine "extraction failed" outcome the document should reflect, not
 * something to retry forever. `removeOnComplete`/`removeOnFail` keep Redis from accumulating job
 * history indefinitely; the durable record of what happened lives in `document_extractions`
 * (created by the worker) and `documents.status`, not in BullMQ's own job store.
 */
export const createExtractionQueue = (connection: Redis): Queue<ExtractionJobData> =>
  new Queue<ExtractionJobData>(EXTRACTION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

export const enqueueExtractionJob = async (queue: Queue<ExtractionJobData>, data: ExtractionJobData): Promise<void> => {
  await queue.add('extract', data, { jobId: data.documentId });
};
