import { Worker } from 'bullmq';
import {
  createQueueRedisConnection,
  EXTRACTION_QUEUE_NAME,
  FACT_AGGREGATION_QUEUE_NAME,
  EMBEDDING_QUEUE_NAME,
  RELAY_QUEUE_NAME,
  RELAY_POLL_QUEUE_NAME,
  type ExtractionJobData,
  type FactAggregationJobData,
  type EmbeddingJobData,
  type RelayJobData,
} from '@retailos/queue';
import { createExtractionProcessor } from './extraction-processor';
import { createFactAggregationProcessor } from './fact-aggregation-processor';
import { createEmbeddingProcessor } from './embedding-processor';
import { createRelayPollProcessor } from './relay-poll-processor';
import { createRuleEvaluationProcessor } from './rule-evaluation-processor';

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
 * the second real `Worker` in this process, consuming the daily fact-aggregation
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
 * the third real `Worker` in this process, consuming the one-shot embedding job enqueued
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

/**
 * The fourth real `Worker` in this process, consuming the repeatable outbox-relay-poll job — "a
 * relay process polls unpublished outbox rows." `job: Job` here carries no meaningful `data` of
 * its own (the poll tick needs no per-invocation parameters — it always sweeps every tenant's
 * current unpublished backlog) — matching the general BullMQ pattern for a pure "tick" job,
 * distinct from every other worker in this file, which all process a specific real domain
 * entity's job data.
 */
export const buildRelayPollWorker = (config: { redisUrl: string; databaseUrl: string }): Worker => {
  const connection = createQueueRedisConnection(config.redisUrl);
  const processor = createRelayPollProcessor({ databaseUrl: config.databaseUrl, redisUrl: config.redisUrl });

  return new Worker(RELAY_POLL_QUEUE_NAME, processor, { connection, concurrency: 1 });
};

/**
 * The fifth real `Worker` in this process, consuming individual relayed events — the real first
 * outbox consumer, giving the rule-evaluation pipeline (rule engine + dedup/aggregation) a real
 * caller for the first time. A separate `Worker`/queue from the poll tick above, matching every
 * other queue pair in this file's own "split by resource profile" convention — the poll is a
 * lightweight periodic DB sweep, while evaluating a relayed event does real per-item lookups and
 * can fan out to future consumers beyond rule evaluation (audit trail, cache invalidation)
 * without touching the poll mechanism at all.
 */
export const buildRuleEvaluationWorker = (config: { redisUrl: string; databaseUrl: string }): Worker<RelayJobData> => {
  const connection = createQueueRedisConnection(config.redisUrl);
  const processor = createRuleEvaluationProcessor({ databaseUrl: config.databaseUrl });

  return new Worker<RelayJobData>(RELAY_QUEUE_NAME, processor, { connection, concurrency: 4 });
};
