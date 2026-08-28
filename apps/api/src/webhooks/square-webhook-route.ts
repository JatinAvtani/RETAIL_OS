import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { PosConnectionLookup, WebhookEventRepository } from '@retailos/db';
import { generateId } from '@retailos/domain';
import { enqueueSquareSyncJob } from '@retailos/queue';
import {
  parseSquareWebhook,
  verifySquareWebhookSignature,
  SquareWebhookParseError,
  type SquareEnvironment,
  type SquareOAuthConfig,
} from '@retailos/pos';
import { db, squareSyncQueue } from '../trpc/context';

const SQUARE_WEBHOOK_SIGNATURE_HEADER = 'x-square-hmacsha256-signature';

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
 * "verify signature → return 200 immediately (vendors retry aggressively
 * on slow responses) → enqueue for processing → dedupe on vendor event id." Registered as its own
 * encapsulated plugin (not inline on `app` directly) SPECIFICALLY so `addContentTypeParser` below is
 * scoped to only this route's prefix — Fastify's plugin encapsulation means the global JSON parser
 * every tRPC procedure and every OTHER plain route relies on is completely untouched. Square's real
 * signature scheme (researched directly against Square's own `square-nodejs-sdk` source, not
 * guessed) requires the RAW, byte-exact request body — Fastify's default JSON parser would have
 * already re-serialized it into a JS object by the time a normal route handler sees it, which
 * produces a different byte sequence (key order, whitespace) than what Square actually signed.
 *
 * "Return 200 immediately" now means what the design's plain-language example actually says:
 * `enqueueSquareSyncJob` hands the real sync (`syncSquareCatalog`/`syncSquareOrders`, now
 * `packages/integrations` — a real BullMQ `Worker` in `apps/worker` consumes it) off the request
 * path entirely, and this route returns as soon as the job is queued. This route used to run the
 * sync SYNCHRONOUSLY, before `apps/worker` had 8 real BullMQ workers — a large catalog paginating
 * 1000 objects/page with no timeout, inside Square's own 10-second webhook delivery window, risked
 * Square abandoning the request and retrying (re-running the same sync again). `webhook_events`'
 * own `processedAt`/`processingError` are now set by the WORKER's processor once the sync actually
 * runs, not by this route — this route only knows the job was accepted, not its outcome.
 */
export const registerSquareWebhookRoute: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Captures the raw request body as a string BEFORE any JSON parsing — scoped to this plugin only.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, callback) => {
    callback(null, body);
  });

  app.post<{ Body: string }>('/webhooks/square', async (request, reply) => {
    const config = readSquareConfig();
    const signingKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
    if (!config || !signingKey || !notificationUrl) {
      // Not configured on this server — same "not an error, just unavailable" convention the
      // OAuth routes use for a missing SQUARE_* config.
      reply.code(503).send({ error: 'Square webhooks are not configured on this server.' });
      return;
    }

    const rawBody = request.body; // the raw string captured by addContentTypeParser above
    const signatureHeader = request.headers[SQUARE_WEBHOOK_SIGNATURE_HEADER];
    if (typeof signatureHeader !== 'string' || !verifySquareWebhookSignature(rawBody, signatureHeader, notificationUrl, signingKey)) {
      // A failed signature check gets a real rejection, not a 200 — Square will retry, which is
      // correct behavior for a REAL delivery that failed verification for a transient reason (a
      // signature-key rotation mid-flight); a permanently-forged request retries harmlessly forever
      // and is never acted on, since it never reaches the connection lookup below.
      reply.code(401).send({ error: 'Invalid webhook signature.' });
      return;
    }

    let parsed;
    try {
      parsed = parseSquareWebhook(rawBody);
    } catch (err) {
      if (err instanceof SquareWebhookParseError) {
        // A genuinely malformed or unrecognized-shape payload from a REAL, signature-verified
        // Square request — still 200, since retrying an unparseable payload will never succeed
        // differently, and Square would otherwise burn its retry budget on this endpoint forever.
        reply.code(200).send({ received: true, parsed: false });
        return;
      }
      throw err;
    }

    const connectionLookup = new PosConnectionLookup(db);
    const connection = await connectionLookup.findByExternalAccount('square', parsed.merchantId);
    if (!connection) {
      // Asked the user, confirmed: an unresolvable merchant_id (orphaned subscription, or a
      // signature that happens to verify against the wrong key) is logged server-side only — no
      // webhook_events row, since organization_id is NOT NULL on that table matching every other
      // tenant table's RLS convention, and there is genuinely no tenant to scope this event to.
      request.log.warn({ merchantId: parsed.merchantId }, 'Square webhook for an unknown merchant_id — no matching pos_connections row.');
      reply.code(200).send({ received: true, resolved: false });
      return;
    }

    const webhookEventRepository = new WebhookEventRepository(db, connection.organizationId);
    const recorded = await webhookEventRepository.recordIfNew({
      id: generateId(),
      posConnectionId: connection.id,
      source: 'square',
      externalEventId: parsed.event.externalEventId,
      eventType: parsed.event.type,
      payload: JSON.parse(rawBody),
    });

    if (recorded.status === 'duplicate') {
      // A retried delivery of an event already accepted — no re-sync, no double-processing.
      reply.code(200).send({ received: true, duplicate: true });
      return;
    }

    // Off the request path — see this route's own top-level doc comment. `webhookEventId` lets the
    // worker processor call `markProcessed` on the SAME row this route just created, so
    // `webhook_events` still ends up with a real, durable outcome — just recorded later, by the
    // process that actually ran the sync.
    await enqueueSquareSyncJob(squareSyncQueue, {
      kind: parsed.event.type === 'catalog.updated' ? 'catalog' : 'orders',
      organizationId: connection.organizationId,
      storeId: connection.storeId,
      webhookEventId: recorded.id,
    });

    reply.code(200).send({ received: true, duplicate: false });
  });

  done();
};
