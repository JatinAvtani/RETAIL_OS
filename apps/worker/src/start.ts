import { buildExtractionWorker } from './worker';

const worker = buildExtractionWorker({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  databaseUrl: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos',
  geminiApiKey: process.env.GEMINI_API_KEY,
  storage: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
    bucket: 'retailos-documents',
  },
});

worker.on('completed', (job) => {
  console.log(`Extraction job ${job.id} completed for document ${job.data.documentId}`);
});

worker.on('failed', (job, err) => {
  console.error(`Extraction job ${job?.id} failed for document ${job?.data.documentId}: ${err.message}`);
});

console.log('Document extraction worker started.');
