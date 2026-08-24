// MUST be the first import: this module reads `process.env` at module scope, and ES imports are
// hoisted — so the env file has to be loaded by a module evaluated BEFORE this one, not by a
// `loadEnv()` call in this file's body (which would run too late). Import order is preserved, so a
// side-effect-only import here is what actually works.
import '@retailos/config/auto';
import { createQueueRedisConnection, createRelayPollQueue, registerRelayPollJob, createBriefingSchedulePollQueue, registerBriefingSchedulePollJob } from '@retailos/queue';
import { buildExtractionWorker, buildFactAggregationWorker, buildEmbeddingWorker, buildRelayPollWorker, buildRuleEvaluationWorker, buildNotificationDeliveryWorker, buildBriefingSchedulePollWorker, buildBriefingWorker } from './worker';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const databaseUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

const extractionWorker = buildExtractionWorker({
  redisUrl,
  databaseUrl,
  geminiApiKey: process.env.GEMINI_API_KEY,
  storage: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
    bucket: 'retailos-documents',
  },
});

extractionWorker.on('completed', (job) => {
  console.log(`Extraction job ${job.id} completed for document ${job.data.documentId}`);
});

extractionWorker.on('failed', (job, err) => {
  console.error(`Extraction job ${job?.id} failed for document ${job?.data.documentId}: ${err.message}`);
});

console.log('Document extraction worker started.');

const factAggregationWorker = buildFactAggregationWorker({ redisUrl, databaseUrl });

factAggregationWorker.on('completed', (job) => {
  console.log(`Fact aggregation job ${job.id} completed for store ${job.data.storeId}`);
});

factAggregationWorker.on('failed', (job, err) => {
  console.error(`Fact aggregation job ${job?.id} failed for store ${job?.data.storeId}: ${err.message}`);
});

console.log('Fact aggregation worker started.');

const embeddingWorker = buildEmbeddingWorker({ redisUrl, databaseUrl, geminiApiKey: process.env.GEMINI_API_KEY });

embeddingWorker.on('completed', (job) => {
  console.log(`Embedding job ${job.id} completed for document ${job.data.documentId}`);
});

embeddingWorker.on('failed', (job, err) => {
  console.error(`Embedding job ${job?.id} failed for document ${job?.data.documentId}: ${err.message}`);
});

console.log('Document embedding worker started.');

const relayPollWorker = buildRelayPollWorker({ redisUrl, databaseUrl });

relayPollWorker.on('completed', (job, result: { relayed: number; total: number }) => {
  if (result.total > 0) {
    console.log(`Outbox relay poll ${job.id}: relayed ${result.relayed}/${result.total} unpublished events.`);
  }
});

relayPollWorker.on('failed', (job, err) => {
  console.error(`Outbox relay poll ${job?.id} failed: ${err.message}`);
});

const ruleEvaluationWorker = buildRuleEvaluationWorker({ redisUrl, databaseUrl });

ruleEvaluationWorker.on('completed', (job) => {
  console.log(`Rule evaluation ${job.id} completed for event ${job.data.eventType} (${job.data.outboxEventId}).`);
});

ruleEvaluationWorker.on('failed', (job, err) => {
  console.error(`Rule evaluation ${job?.id} failed for event ${job?.data.eventType}: ${err.message}`);
});

console.log('Outbox relay + rule evaluation workers started.');

const notificationDeliveryWorker = buildNotificationDeliveryWorker({ redisUrl, databaseUrl });

notificationDeliveryWorker.on('completed', (job) => {
  console.log(`Notification delivery ${job.id} completed for delivery ${job.data.deliveryId}.`);
});

notificationDeliveryWorker.on('failed', (job, err) => {
  console.error(`Notification delivery ${job?.id} failed for delivery ${job?.data.deliveryId}: ${err.message}`);
});

console.log('Notification delivery worker started.');

const briefingSchedulePollWorker = buildBriefingSchedulePollWorker({ redisUrl, databaseUrl });

briefingSchedulePollWorker.on('completed', (job, result: { registered: number; total: number }) => {
  console.log(`Briefing schedule poll ${job.id}: registered ${result.registered}/${result.total} active stores.`);
});

briefingSchedulePollWorker.on('failed', (job, err) => {
  console.error(`Briefing schedule poll ${job?.id} failed: ${err.message}`);
});

const briefingWorker = buildBriefingWorker({ redisUrl, databaseUrl, geminiApiKey: process.env.GEMINI_API_KEY });

briefingWorker.on('completed', (job) => {
  console.log(`Daily briefing ${job.id} completed for store ${job.data.storeId}.`);
});

briefingWorker.on('failed', (job, err) => {
  console.error(`Daily briefing ${job?.id} failed for store ${job?.data.storeId}: ${err.message}`);
});

console.log('Daily briefing schedule-poll + generation workers started.');

// Registers (or re-registers, idempotently) the one system-wide relay-poll schedule — safe to
// call on every worker startup, matching `registerFactAggregationJob`'s own upsert-based
// idempotency (packages/queue).
const relayPollQueue = createRelayPollQueue(createQueueRedisConnection(redisUrl));
await registerRelayPollJob(relayPollQueue);
console.log('Outbox relay poll schedule registered (every 15s).');

const briefingSchedulePollQueue = createBriefingSchedulePollQueue(createQueueRedisConnection(redisUrl));
await registerBriefingSchedulePollJob(briefingSchedulePollQueue);
console.log('Daily briefing schedule-poll registered (every 1h).');
