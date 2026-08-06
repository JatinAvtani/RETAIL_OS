import { Worker } from 'bullmq';
import { createQueueRedisConnection, EXTRACTION_QUEUE_NAME, type ExtractionJobData } from '@retailos/queue';
import { createExtractionProcessor } from './extraction-processor';

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
