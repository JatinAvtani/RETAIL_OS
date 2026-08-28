import type { Job } from 'bullmq';
import { createDb, WebhookEventRepository } from '@retailos/db';
import { syncSquareCatalog, syncSquareOrders, reconcileSquareOrders } from '@retailos/integrations';
import type { SquareEnvironment, SquareOAuthConfig } from '@retailos/pos';
import type { SquareSyncJobData } from '@retailos/queue';

const readSquareConfig = (): SquareOAuthConfig | null => {
  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const applicationSecret = process.env.SQUARE_APPLICATION_SECRET;
  const redirectUri = process.env.SQUARE_REDIRECT_URI;
  const environment = (process.env.SQUARE_ENVIRONMENT ?? 'sandbox') as SquareEnvironment;
  if (!applicationId || !applicationSecret || !redirectUri) {
    return null;
  }
  return { applicationId, applicationSecret, redirectUri, environment };
};

/**
 * The real worker-side handler for a Square sync job (`square-sync-queue.ts`) — moved off the
 * request path from both `square-webhook-route.ts` (a webhook-triggered sync) and
 * `integrations.ts` (a manual "sync now" trigger), which previously ran `syncSquareCatalog`/
 * `syncSquareOrders`/`reconcileSquareOrders` SYNCHRONOUSLY inside the request. Same three real
 * functions, now genuinely shared between `apps/api` and `apps/worker` via `@retailos/integrations`
 * — apps cannot import from each other (module-boundary rule), which is why those functions had to
 * move out of `apps/api` once a second real caller (this processor) needed them.
 *
 * `job.data.webhookEventId`, when present, is the SAME `webhook_events` row the webhook route
 * already created before enqueuing — this processor calls `markProcessed` on it once the sync
 * actually finishes, so the row still ends up with a real, durable outcome even though the route
 * itself returned long before the sync ran. Absent for a manually-triggered sync (no webhook event
 * exists for that case).
 *
 * A missing Square config (not configured on THIS worker process) or an unconfigured encryption
 * key throws — genuinely unrecoverable for this job, not a per-connection sync failure, so BullMQ's
 * own retry/backoff applies rather than this function inventing its own handling.
 */
export const createSquareSyncProcessor = (config: { databaseUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  return async (job: Job<SquareSyncJobData>): Promise<void> => {
    const { kind, organizationId, storeId, webhookEventId } = job.data;

    const squareConfig = readSquareConfig();
    if (!squareConfig) {
      throw new Error('Square integration is not configured on this worker.');
    }
    const encryptionKey = process.env.POS_TOKEN_ENCRYPTION_KEY;

    let processingError: string | undefined;
    try {
      if (kind === 'catalog') {
        await syncSquareCatalog(db, organizationId, storeId, squareConfig, encryptionKey);
      } else if (kind === 'orders') {
        await syncSquareOrders(db, organizationId, storeId, squareConfig, encryptionKey);
      } else {
        await reconcileSquareOrders(db, organizationId, storeId, squareConfig, encryptionKey);
      }
    } catch (err) {
      // The sync functions themselves already record the connection's own status/lastError
      // (recordSuccessfulSync/updateStatus — see square-catalog-sync.ts/square-orders-sync.ts's own
      // doc comments) — this catch exists only to finish marking the webhook_events row below with
      // a real outcome, never to swallow the failure: it rethrows after that, so BullMQ's own
      // attempts/backoff still applies exactly as it would without a webhookEventId.
      processingError = err instanceof Error ? err.message : 'Square sync failed.';
    }

    if (webhookEventId !== undefined) {
      const webhookEventRepository = new WebhookEventRepository(db, organizationId);
      await webhookEventRepository.markProcessed(webhookEventId, processingError);
    }

    if (processingError !== undefined) {
      throw new Error(processingError);
    }
  };
};
