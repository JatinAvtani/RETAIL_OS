import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const SQUARE_SYNC_QUEUE_NAME = 'square-sync';

/** The three real Square sync operations (`apps/api/src/integrations/square-*-sync.ts`) share one
 * queue since they're all "run this Square sync function for one store's connection" — the same
 * failure/retry profile, just a different function invoked. */
export type SquareSyncKind = 'catalog' | 'orders' | 'reconcile';

export interface SquareSyncJobData {
  kind: SquareSyncKind;
  organizationId: string;
  storeId: string;
  /** Present only when this job was enqueued from the webhook route — lets the worker processor
   * call `WebhookEventRepository.markProcessed` on the SAME row the route already created, so
   * `webhook_events` still ends up with a real, durable outcome even though the route itself no
   * longer knows the sync's result (it returns before the sync runs). Absent for a manually
   * triggered sync (`integrations.syncSquareCatalog`/etc.) — there is no webhook_events row for
   * those, matching that table's own "one row per real webhook DELIVERY" scope. */
  webhookEventId?: string;
}

/**
 * Was previously run SYNCHRONOUSLY inside the webhook request and inside the two manual-trigger
 * tRPC mutations — comments at those call sites claimed "the worker is still a placeholder," which
 * stopped being true once `apps/worker` grew 8 real BullMQ workers; the sweep that enqueued
 * document-extraction/embedding/etc. never reached this one. A large catalog sync paginating 1000
 * objects/page with no timeout, run inside Square's own 10-second webhook delivery window, risks
 * Square abandoning the request and retrying (re-running the same sync again) — a real, live risk
 * the synchronous version carried. `jobId` is deliberately NOT set to a fixed per-connection key
 * (unlike `embedding-queue.ts`'s per-document idempotency): a webhook delivery and a manual trigger
 * for the SAME store legitimately queue as two separate, real sync attempts, not a dedup case —
 * `syncSquareCatalog`/`syncSquareOrders` are themselves idempotent (a cursor-driven full
 * re-fetch/upsert), so a harmless double-run is the acceptable cost, not a correctness bug.
 */
export const createSquareSyncQueue = (connection: Redis): Queue<SquareSyncJobData> =>
  new Queue<SquareSyncJobData>(SQUARE_SYNC_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

export const enqueueSquareSyncJob = async (queue: Queue<SquareSyncJobData>, data: SquareSyncJobData): Promise<void> => {
  await queue.add(data.kind, data);
};
