import { Worker } from 'bullmq';
import {
  createQueueRedisConnection,
  EXTRACTION_QUEUE_NAME,
  FACT_AGGREGATION_QUEUE_NAME,
  EMBEDDING_QUEUE_NAME,
  RELAY_QUEUE_NAME,
  RELAY_POLL_QUEUE_NAME,
  NOTIFICATION_DELIVERY_QUEUE_NAME,
  BRIEFING_QUEUE_NAME,
  BRIEFING_SCHEDULE_POLL_QUEUE_NAME,
  SQUARE_SYNC_QUEUE_NAME,
  type ExtractionJobData,
  type FactAggregationJobData,
  type EmbeddingJobData,
  type RelayJobData,
  type NotificationDeliveryJobData,
  type BriefingJobData,
  type SquareSyncJobData,
} from '@retailos/queue';
import { createMockNotificationEmailSender } from '@retailos/email';
import { createExtractionProcessor } from './extraction-processor';
import { createFactAggregationProcessor } from './fact-aggregation-processor';
import { createEmbeddingProcessor } from './embedding-processor';
import { createRelayPollProcessor } from './relay-poll-processor';
import { createRuleEvaluationProcessor } from './rule-evaluation-processor';
import { createNotificationDeliveryProcessor } from './notification-delivery-processor';
import { createBriefingSchedulePollProcessor } from './briefing-schedule-poll-processor';
import { createBriefingProcessor } from './briefing-processor';
import { createSquareSyncProcessor } from './square-sync-processor';

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
  const processor = createRuleEvaluationProcessor({ databaseUrl: config.databaseUrl, redisUrl: config.redisUrl });

  return new Worker<RelayJobData>(RELAY_QUEUE_NAME, processor, { connection, concurrency: 4 });
};

/**
 * The sixth real `Worker` in this process, consuming individual notification-delivery jobs
 * ("email delivery with retry + DLQ") — the real first caller of
 * `NotificationDeliveryRepository.findPending`/`markDelivered`/`markFailed`/`markDeadLettered`,
 * which existed with no consumer beforehand. Its own connection/concurrency, matching every other
 * queue in this file's "split by resource profile" convention — an email send has an unrelated
 * failure/backoff profile from either the extraction/embedding external calls or the relay's own
 * lightweight DB sweep. `emailSender` defaults to the real mock transport (`@retailos/email`,
 * matching `PoEmailSender`'s established no-card/no-cost precedent) — a real provider can be
 * injected later via this same config without touching the processor itself.
 */
export const buildNotificationDeliveryWorker = (config: { redisUrl: string; databaseUrl: string }): Worker<NotificationDeliveryJobData> => {
  const connection = createQueueRedisConnection(config.redisUrl);
  const processor = createNotificationDeliveryProcessor({ databaseUrl: config.databaseUrl, emailSender: createMockNotificationEmailSender() });

  return new Worker<NotificationDeliveryJobData>(NOTIFICATION_DELIVERY_QUEUE_NAME, processor, { connection, concurrency: 4 });
};

/**
 * The seventh real `Worker` in this process, consuming the repeatable briefing-schedule-poll job
 * (genuine per-store-timezone scheduling — see `briefing-queue.ts`'s own header for why
 * this re-derives every store's cron on a recurring tick rather than registering once). A pure
 * "tick" job like `buildRelayPollWorker`'s own poll worker — carries no meaningful per-invocation
 * `job.data` of its own, since it always sweeps every active store's current schedule.
 */
export const buildBriefingSchedulePollWorker = (config: { redisUrl: string; databaseUrl: string }): Worker => {
  const connection = createQueueRedisConnection(config.redisUrl);
  const processor = createBriefingSchedulePollProcessor({ databaseUrl: config.databaseUrl, redisUrl: config.redisUrl });

  return new Worker(BRIEFING_SCHEDULE_POLL_QUEUE_NAME, processor, { connection, concurrency: 1 });
};

/**
 * The eighth real `Worker` in this process, consuming individual per-store daily-briefing
 * generation jobs — the real scheduled-delivery half of the briefing feature, reusing the exact
 * `rankExceptions`/`toBriefingBundle`/`narrateAndValidate` machinery the `assistant.briefing`
 * query already built (I2), delivering through the SAME real notification pipeline already
 * built rather than a separate bespoke path (confirmed with the user).
 */
export const buildBriefingWorker = (config: { redisUrl: string; databaseUrl: string; geminiApiKey: string | undefined }): Worker<BriefingJobData> => {
  const connection = createQueueRedisConnection(config.redisUrl);
  const processor = createBriefingProcessor({ databaseUrl: config.databaseUrl, redisUrl: config.redisUrl, geminiApiKey: config.geminiApiKey });

  return new Worker<BriefingJobData>(BRIEFING_QUEUE_NAME, processor, { connection, concurrency: 2 });
};

/**
 * The ninth real `Worker` in this process — consumes the Square sync job (`square-sync-queue.ts`),
 * moved off the request path from both the webhook route and the two manual-trigger tRPC
 * mutations. Concurrency 2, matching the extraction worker's own reasoning: a real, external,
 * rate-limited vendor API call, not a predictable local computation.
 */
export const buildSquareSyncWorker = (config: { redisUrl: string; databaseUrl: string }): Worker<SquareSyncJobData> => {
  const connection = createQueueRedisConnection(config.redisUrl);
  const processor = createSquareSyncProcessor({ databaseUrl: config.databaseUrl });

  return new Worker<SquareSyncJobData>(SQUARE_SYNC_QUEUE_NAME, processor, { connection, concurrency: 2 });
};
