import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSquareWebhook, verifySquareWebhookSignature, SquareWebhookParseError } from './square';

const NOTIFICATION_URL = 'https://example.com/webhooks/square';
const SIGNING_KEY = 'test-square-webhook-signing-key';

/** A real HMAC-SHA256 computed the exact way Square's own square-nodejs-sdk source computes it (researched, not guessed) — notificationUrl + rawBody, no separator, base64. */
const realSignature = (rawBody: string, notificationUrl = NOTIFICATION_URL, signingKey = SIGNING_KEY): string =>
  createHmac('sha256', signingKey).update(notificationUrl + rawBody, 'utf8').digest('base64');

describe('verifySquareWebhookSignature', () => {
  it('accepts a genuinely correctly-signed payload', () => {
    const rawBody = '{"event_id":"evt-1","merchant_id":"M1","type":"order.updated"}';
    const signature = realSignature(rawBody);
    expect(verifySquareWebhookSignature(rawBody, signature, NOTIFICATION_URL, SIGNING_KEY)).toBe(true);
  });

  it('rejects a signature computed with the wrong signing key', () => {
    const rawBody = '{"event_id":"evt-1","merchant_id":"M1","type":"order.updated"}';
    const signature = realSignature(rawBody, NOTIFICATION_URL, 'a-completely-different-key');
    expect(verifySquareWebhookSignature(rawBody, signature, NOTIFICATION_URL, SIGNING_KEY)).toBe(false);
  });

  it('rejects a signature computed against a DIFFERENT notification URL — the URL is part of the signed string, not just the body', () => {
    const rawBody = '{"event_id":"evt-1","merchant_id":"M1","type":"order.updated"}';
    const signature = realSignature(rawBody, 'https://attacker.example.com/webhooks/square');
    expect(verifySquareWebhookSignature(rawBody, signature, NOTIFICATION_URL, SIGNING_KEY)).toBe(false);
  });

  it('rejects a tampered body even when the original signature is reused', () => {
    const originalBody = '{"event_id":"evt-1","merchant_id":"M1","type":"order.updated"}';
    const signature = realSignature(originalBody);
    const tamperedBody = '{"event_id":"evt-1","merchant_id":"M2","type":"order.updated"}';
    expect(verifySquareWebhookSignature(tamperedBody, signature, NOTIFICATION_URL, SIGNING_KEY)).toBe(false);
  });

  it('rejects a malformed (non-base64-decodable-to-the-right-length) signature header without throwing', () => {
    const rawBody = '{"event_id":"evt-1"}';
    expect(() => verifySquareWebhookSignature(rawBody, 'not-a-real-signature', NOTIFICATION_URL, SIGNING_KEY)).not.toThrow();
    expect(verifySquareWebhookSignature(rawBody, 'not-a-real-signature', NOTIFICATION_URL, SIGNING_KEY)).toBe(false);
  });

  it('rejects an empty signature header', () => {
    const rawBody = '{"event_id":"evt-1"}';
    expect(verifySquareWebhookSignature(rawBody, '', NOTIFICATION_URL, SIGNING_KEY)).toBe(false);
  });
});

describe('parseSquareWebhook', () => {
  it('parses a real order.updated envelope into the canonical ExternalEvent plus merchantId', () => {
    const rawBody = JSON.stringify({
      merchant_id: 'MERCHANT-1',
      type: 'order.updated',
      event_id: 'EVT-ORDER-1',
      created_at: '2026-08-05T00:00:00Z',
      data: {
        type: 'order_updated',
        id: 'ORDER-1',
        object: { order_updated: { order_id: 'ORDER-1', location_id: 'LOC-1', state: 'OPEN', version: 2 } },
      },
    });

    const result = parseSquareWebhook(rawBody);
    expect(result.merchantId).toBe('MERCHANT-1');
    expect(result.event).toEqual({
      externalEventId: 'EVT-ORDER-1',
      type: 'transaction.updated',
      locationExternalId: 'LOC-1',
      transactionExternalId: 'ORDER-1',
    });
  });

  it('parses a catalog.version.updated envelope — no transactionExternalId, since Square carries no specific object id for this event', () => {
    const rawBody = JSON.stringify({
      merchant_id: 'MERCHANT-1',
      type: 'catalog.version.updated',
      event_id: 'EVT-CATALOG-1',
      data: { type: 'catalog_version', id: 'CATVER-1', object: { catalog_version: { updated_at: '2026-08-05T00:00:00Z' } } },
    });

    const result = parseSquareWebhook(rawBody);
    expect(result.event.type).toBe('catalog.updated');
    expect(result.event.transactionExternalId).toBeUndefined();
    expect(result.event.locationExternalId).toBe('MERCHANT-1'); // falls back to merchant_id — no location on this event
  });

  it('parses order.fulfillment.updated the same way as order.updated', () => {
    const rawBody = JSON.stringify({
      merchant_id: 'MERCHANT-1',
      type: 'order.fulfillment.updated',
      event_id: 'EVT-FULFILL-1',
      data: {
        type: 'order_fulfillment_updated',
        id: 'ORDER-2',
        object: { order_fulfillment_updated: { order_id: 'ORDER-2', location_id: 'LOC-1' } },
      },
    });

    const result = parseSquareWebhook(rawBody);
    expect(result.event.type).toBe('transaction.updated');
    expect(result.event.transactionExternalId).toBe('ORDER-2');
  });

  it('throws SquareWebhookParseError on invalid JSON', () => {
    expect(() => parseSquareWebhook('not json')).toThrow(SquareWebhookParseError);
  });

  it('throws SquareWebhookParseError when event_id is missing', () => {
    const rawBody = JSON.stringify({ merchant_id: 'M1', type: 'order.updated' });
    expect(() => parseSquareWebhook(rawBody)).toThrow(SquareWebhookParseError);
  });

  it('throws SquareWebhookParseError when merchant_id is missing', () => {
    const rawBody = JSON.stringify({ event_id: 'EVT-1', type: 'order.updated' });
    expect(() => parseSquareWebhook(rawBody)).toThrow(SquareWebhookParseError);
  });

  it('throws SquareWebhookParseError on a genuinely unrecognized event type, rather than guessing', () => {
    const rawBody = JSON.stringify({ merchant_id: 'M1', event_id: 'EVT-1', type: 'some.future.event.type' });
    expect(() => parseSquareWebhook(rawBody)).toThrow(SquareWebhookParseError);
  });
});
