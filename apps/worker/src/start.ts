import { buildExtractionWorker, buildFactAggregationWorker, buildEmbeddingWorker } from './worker';

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
