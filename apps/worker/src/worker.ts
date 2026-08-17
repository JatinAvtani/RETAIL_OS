import { Worker } from 'bullmq';
import {
  createQueueRedisConnection,
  EXTRACTION_QUEUE_NAME,
  FACT_AGGREGATION_QUEUE_NAME,
  EMBEDDING_QUEUE_NAME,
  type ExtractionJobData,
  type FactAggregationJobData,
  type EmbeddingJobData,
} from '@retailos/queue';
import { createExtractionProcessor } from './extraction-processor';
import { createFactAggregationProcessor } from './fact-aggregation-processor';
import { createEmbeddingProcessor } from './embedding-processor';

/**
 * Factory, not a side-effecting module — mirrors `apps/api`'s `server.ts`/`start.ts` split so this
 * file can be imported for its exports (tests) without binding a real Redis connection as a
 * side effect of import.
 */
export const buildExtractionWorker = (config: {
  redisUrl: string;
  databaseUrl: string;
  geminiApiKey: string | undefined;
  storage: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string };
}): Worker<ExtractionJobData> => {
  const connection = createQueueRedisConnection(config.redisUrl);
  const processor = createExtractionProcessor({
    databaseUrl: config.databaseUrl,
    geminiApiKey: config.geminiApiKey,
    storage: config.storage,
  });

  return new Worker<ExtractionJobData>(EXTRACTION_QUEUE_NAME, processor, { connection, concurrency: 2 });
};

/**
 * 009-01 — the second real `Worker` in this process, consuming the daily fact-aggregation
 * schedule (`packages/queue`'s `upsertJobScheduler`-based repeatable job, one per store). A
 * separate `Worker` instance (its own connection, its own concurrency) rather than a second
 * handler on the extraction worker — the two job types have unrelated failure modes and load
 * profiles (bursty/external-bound OCR vs. a predictable nightly sweep), matching this app's own
 * "split by resource profile" rationale (CLAUDE.md) at the queue level, not just the app level.
 */
export const buildFactAggregationWorker = (config: { redisUrl: string; databaseUrl: string }): Worker<FactAggregationJobData> => {
  const connection = createQueueRedisConnection(config.redisUrl);
  const processor = createFactAggregationProcessor({ databaseUrl: config.databaseUrl });

  return new Worker<FactAggregationJobData>(FACT_AGGREGATION_QUEUE_NAME, processor, { connection, concurrency: 2 });
};

/**
 * 009-18 — the third real `Worker` in this process, consuming the one-shot embedding job enqueued
 * when a document reaches `APPROVED` (see `embedding-queue.ts`). Its own connection/concurrency,
 * matching the same "split by resource profile" reasoning as the fact-aggregation worker — an
 * external, rate-limited Gemini API call has a different failure/backoff profile than either
 * extraction (also external, but a different provider/quota) or the nightly aggregation sweep.
 */
export const buildEmbeddingWorker = (config: { redisUrl: string; databaseUrl: string; geminiApiKey: string | undefined }): Worker<EmbeddingJobData> => {
  const connection = createQueueRedisConnection(config.redisUrl);
  const processor = createEmbeddingProcessor({ databaseUrl: config.databaseUrl, geminiApiKey: config.geminiApiKey });

  return new Worker<EmbeddingJobData>(EMBEDDING_QUEUE_NAME, processor, { connection, concurrency: 2 });
};
