import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { PosConnectionLookup, WebhookEventRepository } from '@retailos/db';
import { generateId } from '@retailos/domain';
import {
  parseSquareWebhook,
  verifySquareWebhookSignature,
  SquareWebhookParseError,
  type SquareEnvironment,
  type SquareOAuthConfig,
} from '@retailos/pos';
import { db } from '../trpc/context';
import { syncSquareCatalog } from '../integrations/square-catalog-sync';
import { syncSquareOrders } from '../integrations/square-orders-sync';

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
 * "Return 200 immediately" is interpreted as "respond within Square's own documented 10-second
 * timeout," not "before doing any work" — asked the user first, confirmed: since no real job
 * queue/worker exists anywhere in this codebase yet (`apps/worker` is still a placeholder), the
 * triggered sync (`syncSquareCatalog`/`syncSquareOrders`) runs SYNCHRONOUSLY, before the response
 * is sent, with its outcome recorded on the `webhook_events` row regardless of whether it
 * succeeded — a future worker can pick up `processedAt IS NULL` rows the same way once one exists,
 * without this route needing to change. A sync that fails does NOT fail the webhook response
 * itself (Square already delivered a genuinely valid, verified event — the response reflects that
 * receipt, not the downstream sync's own success/failure, matching the plan's "webhooks are
 * best-effort; the nightly reconciliation sweep is not optional" framing).
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

    // Best-effort processing, still inside the response window (Square's own documented 10s
    // timeout) — a failed sync here does NOT turn the response into a failure; Square genuinely
    // delivered a valid event, and retrying delivery of the SAME event would not fix a sync-side
    // error. The row's processingError is this failure's real, durable record instead.
    try {
      if (parsed.event.type === 'catalog.updated') {
        await syncSquareCatalog(db, connection.organizationId, connection.storeId, config, process.env.POS_TOKEN_ENCRYPTION_KEY);
      } else {
        await syncSquareOrders(db, connection.organizationId, connection.storeId, config, process.env.POS_TOKEN_ENCRYPTION_KEY);
      }
      await webhookEventRepository.markProcessed(recorded.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Webhook-triggered sync failed.';
      await webhookEventRepository.markProcessed(recorded.id, message);
    }

    reply.code(200).send({ received: true, duplicate: false });
  });

  done();
};
