// MUST be the first import: this module reads `process.env` at module scope, and ES imports are
// hoisted — so the env file has to be loaded by a module evaluated BEFORE this one, not by a
// `loadEnv()` call in this file's body (which would run too late). Import order is preserved, so a
// side-effect-only import here is what actually works.
import '@retailos/config/auto';
import { createQueueRedisConnection, createRelayPollQueue, registerRelayPollJob, createBriefingSchedulePollQueue, registerBriefingSchedulePollJob, createFactAggregationSchedulePollQueue, registerFactAggregationSchedulePollJob, createStockMovementsPartitionQueue, registerStockMovementsPartitionJob, createLotExpirySweepQueue, registerLotExpirySweepJob, createNegativeStockSweepQueue, registerNegativeStockSweepJob, createSalesAnomalySweepQueue, registerSalesAnomalySweepJob, createMarginDropSweepQueue, registerMarginDropSweepJob, createUnmappedPosItemsSweepQueue, registerUnmappedPosItemsSweepJob, createDocumentReviewRequiredSweepQueue, registerDocumentReviewRequiredSweepJob, createSalesConsumptionRetrySweepQueue, registerSalesConsumptionRetrySweepJob, createInvestigationTriggerQueue, registerInvestigationTriggerJob } from '@retailos/queue';
import { buildExtractionWorker, buildFactAggregationWorker, buildEmbeddingWorker, buildRelayPollWorker, buildRuleEvaluationWorker, buildNotificationDeliveryWorker, buildBriefingSchedulePollWorker, buildFactAggregationSchedulePollWorker, buildBriefingWorker, buildSquareSyncWorker, buildStockMovementsPartitionWorker, buildLotExpirySweepWorker, buildNegativeStockSweepWorker, buildSalesAnomalySweepWorker, buildMarginDropSweepWorker, buildUnmappedPosItemsSweepWorker, buildDocumentReviewRequiredSweepWorker, buildSalesConsumptionRetryWorker, buildInvestigationTriggerWorker } from './worker';
import { baseLogger, logJobFailure } from '@retailos/logger';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const databaseUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
// Partition DDL needs the same elevated role migrations run as (`postgres`, never `retailos_app`
// — that role has no CREATE privilege on this schema by design). Falls back to `databaseUrl` only
// if genuinely nothing else is set, so a misconfigured environment fails loudly against Postgres's
// own permission check rather than this file silently picking the wrong role.
const adminDatabaseUrl = process.env.DATABASE_URL ?? databaseUrl;
// Cross-tenant SWEEPS (lot-expiry, negative-stock, and any future admin-connection sweep that only
// needs to SELECT/UPDATE real tenant tables across every org, never CREATE/ALTER/DROP) use
// `retailos_sweeper` — a least-privileged role with the same table grants as `retailos_app` plus
// BYPASSRLS (docker/postgres/init/03-sweeper-role.sql), never the true `postgres` superuser. A
// sweep bug (a missing WHERE clause, a copy-paste error) is contained to data access under this
// role's ordinary table grants; it cannot ALTER a table, manage roles, or bypass any OTHER safety
// mechanism the way a superuser connection could. Falls back to `adminDatabaseUrl` only if
// genuinely nothing else is set, so a misconfigured environment still runs (with the old, broader
// privilege) rather than crashing outright.
const sweepDatabaseUrl = process.env.SWEEP_DATABASE_URL ?? adminDatabaseUrl;
// `relayPollWorker`/`briefingSchedulePollWorker` were ALSO wired to the plain app-role
// `databaseUrl` despite their own processors' doc comments explicitly requiring an
// admin/cross-tenant connection — a real, previously-undetected bug, not a hypothetical one:
// `findUnpublishedOutboxEvents`/`findActiveStoresForScheduling` read `app.current_org_id` via RLS's
// tenant-context mechanism, which is never SET for these sweeps (they read across every tenant in
// one query), so calling them through `retailos_app` throws `unrecognized configuration parameter
// "app.current_org_id"` on every single poll tick — confirmed live against this project's own dev
// database, not assumed from reading the code. BullMQ's own retry swallows the throw (logged via
// the 'failed' handler below) so the worker process itself never crashes, which is exactly why this
// went undetected: nothing outside a worker log line ever surfaced it. Both now use
// `sweepDatabaseUrl` too.

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
  logJobFailure('extraction', job?.id, job?.data, err);
});

console.log('Document extraction worker started.');

const factAggregationWorker = buildFactAggregationWorker({ redisUrl, databaseUrl });

factAggregationWorker.on('completed', (job) => {
  console.log(`Fact aggregation job ${job.id} completed for store ${job.data.storeId}`);
});

factAggregationWorker.on('failed', (job, err) => {
  logJobFailure('fact-aggregation', job?.id, job?.data, err);
});

console.log('Fact aggregation worker started.');

const embeddingWorker = buildEmbeddingWorker({ redisUrl, databaseUrl, geminiApiKey: process.env.GEMINI_API_KEY });

embeddingWorker.on('completed', (job) => {
  console.log(`Embedding job ${job.id} completed for document ${job.data.documentId}`);
});

embeddingWorker.on('failed', (job, err) => {
  logJobFailure('embedding', job?.id, job?.data, err);
});

console.log('Document embedding worker started.');

const relayPollWorker = buildRelayPollWorker({ redisUrl, databaseUrl: sweepDatabaseUrl });

relayPollWorker.on('completed', (job, result: { relayed: number; total: number }) => {
  if (result.total > 0) {
    console.log(`Outbox relay poll ${job.id}: relayed ${result.relayed}/${result.total} unpublished events.`);
  }
});

relayPollWorker.on('failed', (job, err) => {
  logJobFailure('outbox-relay-poll', job?.id, job?.data, err);
});

const ruleEvaluationWorker = buildRuleEvaluationWorker({ redisUrl, databaseUrl });

ruleEvaluationWorker.on('completed', (job) => {
  console.log(`Rule evaluation ${job.id} completed for event ${job.data.eventType} (${job.data.outboxEventId}).`);
});

ruleEvaluationWorker.on('failed', (job, err) => {
  logJobFailure('rule-evaluation', job?.id, job?.data, err);
});

console.log('Outbox relay + rule evaluation workers started.');

const notificationDeliveryWorker = buildNotificationDeliveryWorker({ redisUrl, databaseUrl });

notificationDeliveryWorker.on('completed', (job) => {
  console.log(`Notification delivery ${job.id} completed for delivery ${job.data.deliveryId}.`);
});

notificationDeliveryWorker.on('failed', (job, err) => {
  logJobFailure('notification-delivery', job?.id, job?.data, err);
});

console.log('Notification delivery worker started.');

const briefingSchedulePollWorker = buildBriefingSchedulePollWorker({ redisUrl, databaseUrl: sweepDatabaseUrl });

briefingSchedulePollWorker.on('completed', (job, result: { registered: number; total: number }) => {
  console.log(`Briefing schedule poll ${job.id}: registered ${result.registered}/${result.total} active stores.`);
});

briefingSchedulePollWorker.on('failed', (job, err) => {
  logJobFailure('briefing-schedule-poll', job?.id, job?.data, err);
});

// Same cross-tenant `findActiveStoresForScheduling` read as `briefingSchedulePollWorker` above —
// must use `sweepDatabaseUrl`, not the plain app-role `databaseUrl`, for the same reason.
const factAggregationSchedulePollWorker = buildFactAggregationSchedulePollWorker({ redisUrl, databaseUrl: sweepDatabaseUrl });

factAggregationSchedulePollWorker.on('completed', (job, result: { registered: number; total: number }) => {
  console.log(`Fact aggregation schedule poll ${job.id}: registered ${result.registered}/${result.total} active stores.`);
});

factAggregationSchedulePollWorker.on('failed', (job, err) => {
  logJobFailure('fact-aggregation-schedule-poll', job?.id, job?.data, err);
});

const briefingWorker = buildBriefingWorker({ redisUrl, databaseUrl, geminiApiKey: process.env.GEMINI_API_KEY });

briefingWorker.on('completed', (job) => {
  console.log(`Daily briefing ${job.id} completed for store ${job.data.storeId}.`);
});

briefingWorker.on('failed', (job, err) => {
  logJobFailure('daily-briefing', job?.id, job?.data, err);
});

console.log('Daily briefing schedule-poll + generation workers started.');

const squareSyncWorker = buildSquareSyncWorker({ redisUrl, databaseUrl });

squareSyncWorker.on('completed', (job) => {
  console.log(`Square sync job ${job.id} (${job.data.kind}) completed for store ${job.data.storeId}.`);
});

squareSyncWorker.on('failed', (job, err) => {
  logJobFailure('square-sync', job?.id, job?.data, err);
});

console.log('Square sync worker started.');

const stockMovementsPartitionWorker = buildStockMovementsPartitionWorker({ redisUrl, adminDatabaseUrl });

stockMovementsPartitionWorker.on('completed', (job, result: { ensured: string[]; created: string[]; defaultPartitionRowCount: number }) => {
  console.log(
    `Stock movements partition maintenance ${job.id}: ${result.ensured.length} partition(s) ensured ` +
      `(${result.created.length} newly created), DEFAULT partition row count ${result.defaultPartitionRowCount}.`
  );
});

stockMovementsPartitionWorker.on('failed', (job, err) => {
  logJobFailure('stock-movements-partition', job?.id, job?.data, err);
});

console.log('Stock movements partition maintenance worker started.');

const lotExpirySweepWorker = buildLotExpirySweepWorker({ redisUrl, adminDatabaseUrl: sweepDatabaseUrl });

lotExpirySweepWorker.on('completed', (job, result: { notified: number; groups: number; resolved: number }) => {
  if (result.groups > 0 || result.resolved > 0) {
    console.log(`Lot expiry sweep ${job.id}: notified ${result.notified}/${result.groups} (store, local-date) group(s), resolved ${result.resolved} stale notification(s).`);
  }
});

lotExpirySweepWorker.on('failed', (job, err) => {
  logJobFailure('lot-expiry-sweep', job?.id, job?.data, err);
});

console.log('Lot expiry sweep worker started.');

const negativeStockSweepWorker = buildNegativeStockSweepWorker({ redisUrl, adminDatabaseUrl: sweepDatabaseUrl });

negativeStockSweepWorker.on('completed', (job, result: { notified: number; total: number; resolved: number }) => {
  if (result.total > 0 || result.resolved > 0) {
    console.log(`Negative stock sweep ${job.id}: notified ${result.notified}/${result.total} row(s), resolved ${result.resolved} stale notification(s).`);
  }
});

negativeStockSweepWorker.on('failed', (job, err) => {
  logJobFailure('negative-stock-sweep', job?.id, job?.data, err);
});

console.log('Negative stock sweep worker started.');

const salesAnomalySweepWorker = buildSalesAnomalySweepWorker({ redisUrl, adminDatabaseUrl: sweepDatabaseUrl });

salesAnomalySweepWorker.on('completed', (job, result: { notified: number; storesEvaluated: number; resolved: number }) => {
  if (result.notified > 0 || result.resolved > 0) {
    console.log(`Sales anomaly sweep ${job.id}: notified ${result.notified} anomaly(ies) across ${result.storesEvaluated} store(s), resolved ${result.resolved} stale notification(s).`);
  }
});

salesAnomalySweepWorker.on('failed', (job, err) => {
  logJobFailure('sales-anomaly-sweep', job?.id, job?.data, err);
});

console.log('Sales anomaly sweep worker started.');

const marginDropSweepWorker = buildMarginDropSweepWorker({ redisUrl, adminDatabaseUrl: sweepDatabaseUrl });

marginDropSweepWorker.on('completed', (job, result: { notified: number; storesEvaluated: number; resolved: number }) => {
  if (result.notified > 0 || result.resolved > 0) {
    console.log(`Margin drop sweep ${job.id}: notified ${result.notified} store(s) across ${result.storesEvaluated} evaluated, resolved ${result.resolved} stale notification(s).`);
  }
});

marginDropSweepWorker.on('failed', (job, err) => {
  logJobFailure('margin-drop-sweep', job?.id, job?.data, err);
});

console.log('Margin drop sweep worker started.');

const unmappedPosItemsSweepWorker = buildUnmappedPosItemsSweepWorker({ redisUrl, adminDatabaseUrl: sweepDatabaseUrl });

unmappedPosItemsSweepWorker.on('completed', (job, result: { notified: number; storesEvaluated: number; resolved: number }) => {
  if (result.notified > 0 || result.resolved > 0) {
    console.log(`Unmapped POS items sweep ${job.id}: notified ${result.notified} store(s) across ${result.storesEvaluated} evaluated, resolved ${result.resolved} stale notification(s).`);
  }
});

unmappedPosItemsSweepWorker.on('failed', (job, err) => {
  logJobFailure('unmapped-pos-items-sweep', job?.id, job?.data, err);
});

console.log('Unmapped POS items sweep worker started.');

const documentReviewRequiredSweepWorker = buildDocumentReviewRequiredSweepWorker({ redisUrl, adminDatabaseUrl: sweepDatabaseUrl });

documentReviewRequiredSweepWorker.on('completed', (job, result: { notified: number; storesEvaluated: number; resolved: number }) => {
  if (result.notified > 0 || result.resolved > 0) {
    console.log(`Document review-required sweep ${job.id}: notified ${result.notified} store(s) across ${result.storesEvaluated} evaluated, resolved ${result.resolved} stale notification(s).`);
  }
});

documentReviewRequiredSweepWorker.on('failed', (job, err) => {
  logJobFailure('document-review-required-sweep', job?.id, job?.data, err);
});

console.log('Document review-required sweep worker started.');

const salesConsumptionRetryWorker = buildSalesConsumptionRetryWorker({ redisUrl, adminDatabaseUrl: sweepDatabaseUrl });

salesConsumptionRetryWorker.on('completed', (job, result: { retried: number; recovered: number; stillFailing: number }) => {
  if (result.retried > 0) {
    console.log(`Sales consumption retry sweep ${job.id}: retried ${result.retried} transaction(s), recovered ${result.recovered}, still failing ${result.stillFailing}.`);
  }
});

salesConsumptionRetryWorker.on('failed', (job, err) => {
  console.error(`Sales consumption retry sweep ${job?.id} failed: ${err.message}`);
});

console.log('Sales consumption retry sweep worker started.');

const investigationTriggerWorker = buildInvestigationTriggerWorker({ redisUrl, adminDatabaseUrl: sweepDatabaseUrl, geminiApiKey: process.env.GEMINI_API_KEY });

investigationTriggerWorker.on('completed', (job, result: { investigated: number; skipped: number; failed: number }) => {
  if (result.investigated > 0 || result.failed > 0) {
    console.log(`Investigation trigger sweep ${job.id}: investigated ${result.investigated}, skipped ${result.skipped} (already in progress), failed ${result.failed}.`);
  }
});

investigationTriggerWorker.on('failed', (job, err) => {
  console.error(`Investigation trigger sweep ${job?.id} failed: ${err.message}`);
});

console.log('Investigation trigger sweep worker started.');

// Registers (or re-registers, idempotently) the one system-wide relay-poll schedule — safe to
// call on every worker startup, matching `registerFactAggregationJob`'s own upsert-based
// idempotency (packages/queue).
const relayPollQueue = createRelayPollQueue(createQueueRedisConnection(redisUrl));
await registerRelayPollJob(relayPollQueue);
console.log('Outbox relay poll schedule registered (every 15s).');

const briefingSchedulePollQueue = createBriefingSchedulePollQueue(createQueueRedisConnection(redisUrl));
await registerBriefingSchedulePollJob(briefingSchedulePollQueue);
console.log('Daily briefing schedule-poll registered (every 1h).');

const factAggregationSchedulePollQueue = createFactAggregationSchedulePollQueue(createQueueRedisConnection(redisUrl));
await registerFactAggregationSchedulePollJob(factAggregationSchedulePollQueue);
console.log('Fact aggregation schedule-poll registered (every 1h).');

const stockMovementsPartitionQueue = createStockMovementsPartitionQueue(createQueueRedisConnection(redisUrl));
await registerStockMovementsPartitionJob(stockMovementsPartitionQueue);
console.log('Stock movements partition maintenance registered (daily, 03:00 UTC).');

const lotExpirySweepQueue = createLotExpirySweepQueue(createQueueRedisConnection(redisUrl));
await registerLotExpirySweepJob(lotExpirySweepQueue);
console.log('Lot expiry sweep registered (every 30m).');

const negativeStockSweepQueue = createNegativeStockSweepQueue(createQueueRedisConnection(redisUrl));
await registerNegativeStockSweepJob(negativeStockSweepQueue);
console.log('Negative stock sweep registered (every 30m).');

const salesAnomalySweepQueue = createSalesAnomalySweepQueue(createQueueRedisConnection(redisUrl));
await registerSalesAnomalySweepJob(salesAnomalySweepQueue);
console.log('Sales anomaly sweep registered (every 6h).');

const marginDropSweepQueue = createMarginDropSweepQueue(createQueueRedisConnection(redisUrl));
await registerMarginDropSweepJob(marginDropSweepQueue);
console.log('Margin drop sweep registered (every 6h).');

const unmappedPosItemsSweepQueue = createUnmappedPosItemsSweepQueue(createQueueRedisConnection(redisUrl));
await registerUnmappedPosItemsSweepJob(unmappedPosItemsSweepQueue);
console.log('Unmapped POS items sweep registered (every 30m).');

const documentReviewRequiredSweepQueue = createDocumentReviewRequiredSweepQueue(createQueueRedisConnection(redisUrl));
await registerDocumentReviewRequiredSweepJob(documentReviewRequiredSweepQueue);
console.log('Document review-required sweep registered (every 30m).');

const salesConsumptionRetrySweepQueue = createSalesConsumptionRetrySweepQueue(createQueueRedisConnection(redisUrl));
await registerSalesConsumptionRetrySweepJob(salesConsumptionRetrySweepQueue);
console.log('Sales consumption retry sweep registered (every 5m).');

const investigationTriggerQueue = createInvestigationTriggerQueue(createQueueRedisConnection(redisUrl));
await registerInvestigationTriggerJob(investigationTriggerQueue);
console.log('Investigation trigger sweep registered (every 15m).');

/**
 * Graceful shutdown: BullMQ's own documented contract is that `Worker.close()` stops accepting new
 * jobs and waits for whatever is currently ACTIVE on that worker to finish before resolving — a
 * signal-driven `process.exit()` with no `close()` call kills every in-flight job mid-write, which
 * "the outbox makes this safe" was, until now, a design argument with no real test or shutdown path
 * behind it (a job that started but never wrote its outbox row leaves no record it ever ran, and
 * BullMQ's own retry only fires for a job that FAILED, not one whose process vanished mid-run).
 * `Promise.allSettled` (not `Promise.all`) so one worker's close hanging or throwing does not
 * prevent the others from getting their own chance to drain.
 */
const allWorkers = [
  extractionWorker,
  factAggregationWorker,
  embeddingWorker,
  relayPollWorker,
  ruleEvaluationWorker,
  notificationDeliveryWorker,
  briefingSchedulePollWorker,
  factAggregationSchedulePollWorker,
  briefingWorker,
  squareSyncWorker,
  stockMovementsPartitionWorker,
  lotExpirySweepWorker,
  negativeStockSweepWorker,
  salesAnomalySweepWorker,
  marginDropSweepWorker,
  unmappedPosItemsSweepWorker,
  documentReviewRequiredSweepWorker,
  salesConsumptionRetryWorker,
  investigationTriggerWorker,
];

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return; // a second SIGTERM/SIGINT while already draining must not re-enter this
  shuttingDown = true;
  console.log(`${signal} received — closing ${allWorkers.length} workers (waiting for active jobs to finish)...`);
  const results = await Promise.allSettled(allWorkers.map((w) => w.close()));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const failure of failures) {
    baseLogger.error({ reason: failure.reason }, 'A worker failed to close cleanly');
  }
  console.log('Worker shutdown complete.');
  process.exit(failures.length > 0 ? 1 : 0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Never silently swallowed and never a silent crash either — logged with full context so a real
// failure (a promise rejection nothing in this codebase awaited) is visible in whatever collects
// this process's stderr, matching this file's own established console.error convention.
process.on('unhandledRejection', (reason) => {
  baseLogger.error({ reason }, 'Unhandled promise rejection in worker process');
});
