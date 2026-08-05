import { createHmac, timingSafeEqual } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { ExternalCheck, ExternalEvent, ExternalEventType, ExternalMoney, ExternalTransaction, ExternalTransactionLine, ExternalTransactionStatus, Page } from './canonical-model';

/**
 * 006-03: Square's real OAuth 2.0 endpoints and shapes (researched, not guessed — see the
 * function-level comments for the specific, non-obvious details that would otherwise be easy to
 * get wrong). Mirrors `apps/api/src/oauth/google.ts`'s shape (config type, `buildAuthorizationUrl`,
 * `exchangeCodeForToken`) — same problem shape, different vendor, deliberately not shared code
 * across the two since Square's response fields (`expires_at` as an ISO string, not
 * seconds-until-expiry) and OAuth mechanics (no `response_type` param, a `session=false` flag)
 * differ enough that a shared abstraction would need vendor branches inside it anyway.
 */

export type SquareEnvironment = 'sandbox' | 'production';

export type SquareOAuthConfig = {
  applicationId: string;
  applicationSecret: string;
  redirectUri: string;
  environment: SquareEnvironment;
};

/** Pinned explicitly (Square's own recommendation) rather than left floating — a version bump is a deliberate code change, not something that silently shifts under this codebase. */
const SQUARE_API_VERSION = '2026-07-16';

const squareHost = (environment: SquareEnvironment): string =>
  environment === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';

/**
 * Scopes kept to exactly what this codebase's sync tasks need (006-04 catalog, 006-05 orders,
 * 006-06 webhooks don't need extra scope) — spec 13 §13.3's "scopes requested minimally (read-only
 * wherever the vendor permits)".
 */
const REQUIRED_SCOPES = ['MERCHANT_PROFILE_READ', 'ITEMS_READ', 'ORDERS_READ'];

export const buildSquareAuthorizationUrl = (config: SquareOAuthConfig, state: string): string => {
  const url = new URL('/oauth2/authorize', squareHost(config.environment));
  url.searchParams.set('client_id', config.applicationId);
  url.searchParams.set('scope', REQUIRED_SCOPES.join(' '));
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  // Square's own documented requirement in production: forces the account picker even with an
  // existing browser session, so a seller with multiple Square accounts doesn't silently connect
  // the wrong one. Ignored (harmless) in sandbox. No `response_type` param exists on this endpoint
  // — unlike Google's generic OAuth shape, Square's authorize endpoint has no other response mode.
  url.searchParams.set('session', 'false');
  return url.toString();
};

export type SquareTokenResponse = {
  accessToken: string;
  refreshToken: string;
  /** Square returns this as an ISO 8601 timestamp string, not seconds-until-expiry like most OAuth providers. */
  expiresAt: Date;
  merchantId: string;
  shortLived: boolean;
};

const parseSquareTokenResponse = (body: {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id?: string;
  short_lived?: boolean;
}): SquareTokenResponse => {
  if (!body.access_token || !body.refresh_token || !body.expires_at || !body.merchant_id) {
    throw new Error('Square token response was missing a required field.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(body.expires_at),
    merchantId: body.merchant_id,
    shortLived: body.short_lived ?? false,
  };
};

/**
 * Exchanges the one-time authorization code for tokens. Throws on any failure — the caller (the
 * Fastify connect-callback route, 006-03's own task) maps this to a generic user-facing error; no
 * partial-success case exists worth distinguishing to the caller, same convention
 * `exchangeCodeForGoogleIdentity` already established.
 */
export const exchangeSquareCodeForToken = async (config: SquareOAuthConfig, code: string): Promise<SquareTokenResponse> => {
  const response = await fetch(new URL('/oauth2/token', squareHost(config.environment)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_API_VERSION },
    body: JSON.stringify({
      client_id: config.applicationId,
      client_secret: config.applicationSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`Square token exchange failed: ${response.status}`);
  }
  return parseSquareTokenResponse(
    (await response.json()) as Parameters<typeof parseSquareTokenResponse>[0]
  );
};

/**
 * Square access tokens last ~30 days (24h if `short_lived` at exchange time) — spec 13 §13.3's
 * "automatic refresh with failure alerting" needs this same token endpoint with a different grant
 * type. Not wired to a scheduled job in 006-03 (that belongs to whichever later task owns the
 * sync scheduler) — this function only proves the refresh CALL itself is correct.
 */
export const refreshSquareToken = async (config: SquareOAuthConfig, refreshToken: string): Promise<SquareTokenResponse> => {
  const response = await fetch(new URL('/oauth2/token', squareHost(config.environment)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_API_VERSION },
    body: JSON.stringify({
      client_id: config.applicationId,
      client_secret: config.applicationSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new Error(`Square token refresh failed: ${response.status}`);
  }
  return parseSquareTokenResponse(
    (await response.json()) as Parameters<typeof parseSquareTokenResponse>[0]
  );
};

export type SquareLocation = {
  externalId: string;
  name: string;
  timezone: string;
};

/**
 * The first real authenticated Square API call this codebase makes — used right after a connect
 * completes so `PosConnectionRepository` can store `externalLocationId` immediately, rather than
 * leaving it null until 006-04's catalog sync happens to run.
 */
export const fetchSquareLocations = async (config: SquareOAuthConfig, accessToken: string): Promise<SquareLocation[]> => {
  const response = await fetch(new URL('/v2/locations', squareHost(config.environment)), {
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_API_VERSION },
  });

  if (!response.ok) {
    throw new Error(`Square locations fetch failed: ${response.status}`);
  }

  const body = (await response.json()) as { locations?: Array<{ id?: string; name?: string; timezone?: string }> };
  return (body.locations ?? [])
    .filter((loc): loc is { id: string; name: string; timezone: string } => Boolean(loc.id && loc.name && loc.timezone))
    .map((loc) => ({ externalId: loc.id, name: loc.name, timezone: loc.timezone }));
};

/**
 * Square's raw wire shape for one catalog object, kept narrow to exactly the fields this codebase
 * reads — researched directly against Square's `SearchCatalogObjects` reference (not guessed):
 * `item_data.categories` is the current field (`item_data.category_id` is deprecated, deliberately
 * not read here), `price_money` is ABSENT entirely — not null, not zero — when a variation's
 * `pricing_type` is `VARIABLE_PRICING`, and `is_deleted` lives on the object wrapper, not nested.
 */
type SquareCatalogObjectWire = {
  id?: string;
  type?: string;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    categories?: Array<{ id?: string }>;
    variations?: SquareCatalogObjectWire[];
  };
  item_variation_data?: {
    name?: string;
    sku?: string;
    pricing_type?: string;
    price_money?: { amount?: number; currency?: string };
  };
};

export type SquareCatalogItemVariation = {
  externalId: string;
  name: string;
  sku?: string;
  /** Undefined (not `0`) when Square's own `pricing_type` is `VARIABLE_PRICING` — I7: an open-priced variation has no knowable price, never a guessed one. */
  price?: { amount: string; currency: string };
};

export type SquareCatalogItem = {
  externalId: string;
  name: string;
  isDeleted: boolean;
  category?: string;
  variations: SquareCatalogItemVariation[];
};

const parseVariation = (wire: SquareCatalogObjectWire): SquareCatalogItemVariation | null => {
  const data = wire.item_variation_data;
  if (!wire.id || !data?.name) return null;
  const priceMoney = data.price_money;
  return {
    externalId: wire.id,
    name: data.name,
    ...(data.sku !== undefined ? { sku: data.sku } : {}),
    ...(priceMoney?.amount !== undefined && priceMoney.currency !== undefined
      ? {
          // Square's price_money.amount is an integer in minor units (cents) — Decimal division,
          // not raw JS float division, so a large cent value can't accumulate a rounding error
          // before this crosses into the codebase's own Decimal-backed Money type downstream (I5).
          price: { amount: new Decimal(priceMoney.amount).dividedBy(100).toFixed(2), currency: priceMoney.currency },
        }
      : {}),
  };
};

const parseItem = (wire: SquareCatalogObjectWire): SquareCatalogItem | null => {
  const data = wire.item_data;
  if (!wire.id || !data?.name) return null;
  return {
    externalId: wire.id,
    name: data.name,
    isDeleted: wire.is_deleted ?? false,
    ...(data.categories?.[0]?.id !== undefined ? { category: data.categories[0].id } : {}),
    variations: (data.variations ?? []).map(parseVariation).filter((v): v is SquareCatalogItemVariation => v !== null),
  };
};

/**
 * `POST /v2/catalog/search-catalog-objects`, not `GET /v2/catalog/list` — researched first (a
 * subagent web search against Square's real API reference): `list` never returns deleted objects at
 * all, with no way to opt in, which makes it useless for detecting "this item existed before, now
 * gone from Square" (needed so 006-04's sync can mark a `pos_items` row delisted rather than
 * silently leaving a stale one). `include_deleted_objects: true` is what surfaces `is_deleted` on
 * each returned object; `object_types: ['ITEM']` also returns every ITEM's nested ITEM_VARIATION
 * children inline (`item_data.variations`), so no separate variation fetch is needed.
 */
export const fetchSquareCatalog = async (
  config: SquareOAuthConfig,
  accessToken: string,
  cursor?: string
): Promise<{ items: SquareCatalogItem[]; nextCursor?: string }> => {
  const response = await fetch(new URL('/v2/catalog/search-catalog-objects', squareHost(config.environment)), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_API_VERSION,
    },
    body: JSON.stringify({
      object_types: ['ITEM'],
      include_deleted_objects: true,
      limit: 1000,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Square catalog fetch failed: ${response.status}`);
  }

  const body = (await response.json()) as { objects?: SquareCatalogObjectWire[]; cursor?: string };
  const items = (body.objects ?? []).map(parseItem).filter((item): item is SquareCatalogItem => item !== null);
  return { items, ...(body.cursor !== undefined ? { nextCursor: body.cursor } : {}) };
};

/**
 * 006-05: Square's raw `Order` wire shape, researched directly against Square's `SearchOrders`/
 * `Order` reference (not guessed) — kept narrow to exactly the fields this codebase's canonical
 * mapping reads. `state` has FOUR real values (`OPEN`, `DRAFT`, `COMPLETED`, `CANCELED`), not the
 * three that would be a natural first guess; only `COMPLETED`/`CANCELED` map into
 * `ExternalTransaction` (asked the user, confirmed — an `OPEN`/`DRAFT` order isn't a final sale
 * yet). `refunds[]` lives on the SAME order object, not a separate one — a refund issued after the
 * original sale bumps the order's own `updated_at`, which is exactly why the incremental filter
 * below is `updated_at`, not `created_at` (filtering on `created_at` would silently miss it).
 */
type SquareOrderWire = {
  id?: string;
  location_id?: string;
  created_at?: string;
  updated_at?: string;
  state?: string;
  line_items?: Array<{
    uid?: string;
    catalog_object_id?: string;
    name?: string;
    quantity?: string;
    base_price_money?: { amount?: number; currency?: string };
    total_discount_money?: { amount?: number; currency?: string };
    total_money?: { amount?: number; currency?: string };
  }>;
  total_money?: { amount?: number; currency?: string };
  total_tax_money?: { amount?: number; currency?: string };
  total_discount_money?: { amount?: number; currency?: string };
  /**
   * Researched directly against Square's Orders API reference (006-05's session): a refund lives
   * as an entry in this array on the SAME order object, not a separate object needing its own
   * fetch — a refund issued after the sale bumps the order's own `updated_at`, which is exactly why
   * `fetchSquareOrders`'s incremental filter is `updated_at`, not `created_at`. Each entry's
   * `status` can be `PENDING`/`APPROVED`/`REJECTED`/`FAILED` — only `APPROVED` (Square's own
   * "this refund genuinely completed" state) counts toward `refundedAmount` below; a `PENDING` or
   * `FAILED` refund attempt must not be treated as money that actually left, or this codebase would
   * report revenue reduced and consumption reversed for a refund that never actually completed.
   */
  refunds?: Array<{ amount_money?: { amount?: number; currency?: string }; status?: string }>;
};

/** Square's minor-unit integer cents -> this codebase's decimal-string ExternalMoney, via Decimal (I5) — same conversion `fetchSquareCatalog` already uses, factored out since orders need it on many more fields. */
const toExternalMoney = (money: { amount?: number; currency?: string } | undefined): ExternalMoney | null => {
  if (money?.amount === undefined || money.currency === undefined) return null;
  return { amount: new Decimal(money.amount).dividedBy(100).toFixed(2), currency: money.currency as ExternalMoney['currency'] };
};

const ZERO_MONEY = (currency: ExternalMoney['currency']): ExternalMoney => ({ amount: '0.00', currency });

/**
 * Maps ONE Square line item into `ExternalTransactionLine` — `catalog_object_id` is the same
 * `ITEM_VARIATION` id `fetchSquareCatalog` already stores as `pos_items.external_id`, so this is
 * the join key the ingestion pipeline (006-07+) uses to resolve `posItemId`, not a foreign key this
 * function itself resolves (this is a pure vendor-shape mapper, no database access). Square's own
 * Orders API has no per-line `voided` concept (unlike a hypothetical partial-void line) — `false`
 * always, matching Square's real model where cancellation is order-level (`state: 'CANCELED'`), not
 * per-line.
 */
const mapOrderLine = (wire: NonNullable<SquareOrderWire['line_items']>[number], currency: ExternalMoney['currency']): ExternalTransactionLine | null => {
  if (!wire.uid || !wire.catalog_object_id || !wire.name || !wire.quantity) return null;
  return {
    externalId: wire.uid,
    posItemExternalId: wire.catalog_object_id,
    name: wire.name,
    quantity: wire.quantity,
    unitPrice: toExternalMoney(wire.base_price_money) ?? ZERO_MONEY(currency),
    discount: toExternalMoney(wire.total_discount_money) ?? ZERO_MONEY(currency),
    lineTotal: toExternalMoney(wire.total_money) ?? ZERO_MONEY(currency),
    modifiers: [], // Square's OrderLineItemModifier[] — not read by this codebase yet (no consumer needs it before 006-08/refunds)
    voided: false,
  };
};

const ORDER_STATE_MAP: Record<string, ExternalTransactionStatus | undefined> = {
  COMPLETED: 'completed',
  CANCELED: 'voided',
};

/**
 * Sums only `APPROVED` refund entries (Square's own "this refund genuinely completed" state) —
 * `PENDING`/`REJECTED`/`FAILED` entries must not count as money that actually left, or a caller
 * would reduce revenue and reverse consumption for a refund that never completed. Returns `null`
 * (not `ZERO_MONEY`) when there are no approved refunds — I7: the absence of a refund is a
 * different fact from a refund of exactly $0.00, and this codebase never collapses "unknown/none"
 * into a zero value a caller could mistake for a real observation.
 */
const sumApprovedRefunds = (wire: SquareOrderWire, currency: ExternalMoney['currency']): ExternalMoney | null => {
  const approved = (wire.refunds ?? []).filter((r) => r.status === 'APPROVED');
  if (approved.length === 0) return null;
  const totalCents = approved.reduce((sum, r) => sum + (r.amount_money?.amount ?? 0), 0);
  if (totalCents === 0) return null;
  return { amount: new Decimal(totalCents).dividedBy(100).toFixed(2), currency };
};

/**
 * Maps one Square Order into `ExternalTransaction` — Square has no sub-order payment splitting
 * (canonical-model.ts's own documented reasoning), so this always produces a single-element
 * `checks` array, never a flat shape. Returns `null` for an `OPEN`/`DRAFT` order (not yet final —
 * asked the user, confirmed 006-05 doesn't sync these) or any order missing a field this mapping
 * requires, so the caller can skip it rather than writing a malformed row.
 *
 * 006-08: `status` becomes `'refunded'` only when the summed approved refund amount equals (or
 * exceeds, a defensive `>=` for any float/rounding edge Square's own totals might produce) the
 * order's own total — a FULL refund. A partial refund keeps `status: 'completed'` with
 * `refundedAmount` set below the total; the caller (006-08's ingestion handler) computes the
 * reversal fraction from `refundedAmount / total` and decides how to record it, this mapper only
 * carries the raw facts.
 */
const mapSquareOrder = (wire: SquareOrderWire): ExternalTransaction | null => {
  const status = wire.state ? ORDER_STATE_MAP[wire.state] : undefined;
  if (!wire.id || !wire.location_id || !wire.created_at || !status) return null;

  const currency = (wire.total_money?.currency ?? wire.line_items?.[0]?.base_price_money?.currency ?? 'USD') as ExternalMoney['currency'];
  const lines = (wire.line_items ?? []).map((line) => mapOrderLine(line, currency)).filter((l): l is ExternalTransactionLine => l !== null);

  const check: ExternalCheck = {
    externalId: wire.id,
    lines,
    subtotal: toExternalMoney(wire.total_money) ?? ZERO_MONEY(currency),
    discount: toExternalMoney(wire.total_discount_money) ?? ZERO_MONEY(currency),
    tax: toExternalMoney(wire.total_tax_money) ?? ZERO_MONEY(currency),
    total: toExternalMoney(wire.total_money) ?? ZERO_MONEY(currency),
  };

  const refundedAmount = sumApprovedRefunds(wire, currency);
  const isFullyRefunded = refundedAmount !== null && new Decimal(refundedAmount.amount).gte(check.total.amount);

  return {
    externalId: wire.id,
    locationExternalId: wire.location_id,
    occurredAt: new Date(wire.created_at),
    status: isFullyRefunded ? 'refunded' : status,
    ...(refundedAmount !== null ? { refundedAmount } : {}),
    checks: [check],
  };
};

/**
 * `POST /v2/orders/search`, incremental on `updated_at` (not `created_at` — researched first: a
 * refund recorded after the original sale bumps `updated_at`, so filtering on `created_at` would
 * silently miss it forever). `since` becomes the window's `start_at`; Square requires `sort_field`
 * to match whichever `date_time_filter` field is populated. Only `COMPLETED`/`CANCELED` orders are
 * requested via `state_filter` — Square still returns the state on each object, but filtering
 * server-side avoids paying for/paginating through `OPEN`/`DRAFT` orders this codebase discards
 * anyway.
 */
export const fetchSquareOrders = async (
  config: SquareOAuthConfig,
  accessToken: string,
  locationId: string,
  since: Date,
  cursor?: string
): Promise<Page<ExternalTransaction>> => {
  const response = await fetch(new URL('/v2/orders/search', squareHost(config.environment)), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_API_VERSION,
    },
    body: JSON.stringify({
      location_ids: [locationId],
      limit: 500,
      query: {
        filter: {
          date_time_filter: { updated_at: { start_at: since.toISOString() } },
          state_filter: { states: ['COMPLETED', 'CANCELED'] },
        },
        sort: { sort_field: 'UPDATED_AT', sort_order: 'ASC' },
      },
      ...(cursor !== undefined ? { cursor } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Square orders fetch failed: ${response.status}`);
  }

  const body = (await response.json()) as { orders?: SquareOrderWire[]; cursor?: string };
  const items = (body.orders ?? []).map(mapSquareOrder).filter((order): order is ExternalTransaction => order !== null);
  return { items, ...(body.cursor !== undefined ? { nextCursor: body.cursor } : {}) };
};

/**
 * 006-06: Square's real webhook signature scheme, researched directly against Square's own
 * `square-nodejs-sdk` source (`WebhooksHelper.ts`/`createHmacOverride.ts`), not guessed — the
 * string-to-sign is `notificationUrl + rawRequestBody` concatenated with NO separator (the full
 * webhook subscription URL as registered in Square's dashboard, not just the path), HMAC-SHA256,
 * base64-encoded — not hex. `notificationUrl` is genuinely required, unlike a typical HMAC webhook
 * scheme that signs the body alone; passing only the body here would make every signature check
 * fail against a real Square delivery. `rawRequestBody` must be the untouched raw bytes/string
 * Fastify received — re-serializing a parsed JSON object before verifying would produce a different
 * byte sequence (key order, whitespace) and fail even for a genuine, unmodified request.
 *
 * `timingSafeEqual` (not `===`) per Square's own documented guidance against timing attacks; both
 * sides are base64-decoded to `Buffer`s of the same length first, since `timingSafeEqual` throws on
 * mismatched lengths rather than returning `false` — a length mismatch is exactly as invalid as a
 * content mismatch, so it's caught explicitly and returns `false`.
 */
export const verifySquareWebhookSignature = (
  rawBody: string,
  signatureHeader: string,
  notificationUrl: string,
  signingKey: string
): boolean => {
  const expected = createHmac('sha256', signingKey).update(notificationUrl + rawBody, 'utf8').digest('base64');
  const expectedBuffer = Buffer.from(expected, 'base64');
  const actualBuffer = Buffer.from(signatureHeader, 'base64');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
};

/**
 * Square's real webhook envelope, researched directly against Square's `order.updated`/
 * `catalog.version.updated` reference docs — `event_id` (the vendor dedup key
 * `ExternalEvent.externalEventId` exists for), `merchant_id`, and `data.object.<snake_case of
 * data.type>` holding the type-specific changed-object reference (there is no single, uniform
 * `data.id` shape across event families — an order event's real object id lives nested inside
 * `data.object.order_updated.order_id`, not `data.id` alone). `catalog.version.updated` carries NO
 * specific object id at all — it is Square's own "something changed, go re-sync" signal, not a
 * pointer to one changed item, mapped to this codebase's `'catalog.updated'` with no
 * `transactionExternalId`.
 */
type SquareWebhookEnvelope = {
  merchant_id?: string;
  type?: string;
  event_id?: string;
  data?: {
    type?: string;
    id?: string;
    object?: {
      order_updated?: { order_id?: string; location_id?: string };
      order_fulfillment_updated?: { order_id?: string; location_id?: string };
      catalog_version?: { updated_at?: string };
    };
  };
};

const SQUARE_EVENT_TYPE_MAP: Record<string, ExternalEventType | undefined> = {
  'order.created': 'transaction.updated',
  'order.updated': 'transaction.updated',
  'order.fulfillment.updated': 'transaction.updated',
  'catalog.version.updated': 'catalog.updated',
};

export class SquareWebhookParseError extends Error {
  constructor(reason: string) {
    super(`Square webhook payload could not be parsed: ${reason}`);
    this.name = 'SquareWebhookParseError';
  }
}

/**
 * `ExternalEvent` (the canonical, vendor-agnostic shape) has no field for a vendor account
 * identifier — deliberately, since that routing detail is specific to how each vendor's webhook
 * envelope is structured, not something every vendor necessarily carries at the event level.
 * Square's OWN envelope carries `merchant_id` at the top level, which is exactly what the route
 * needs to resolve `pos_connections.externalAccountId -> organizationId` BEFORE it can trust
 * anything else in the payload as belonging to a specific tenant — so this Square-specific wrapper
 * type surfaces it alongside the canonical event, rather than forcing it into (or losing it from)
 * `ExternalEvent` itself.
 */
export type SquareParsedWebhook = { event: ExternalEvent; merchantId: string };

/**
 * Parses an ALREADY-signature-verified raw webhook body into the canonical `ExternalEvent` shape
 * plus Square's own `merchant_id` (see `SquareParsedWebhook`). Throws (never returns a best-guess
 * partial event) on a genuinely unrecognized `type` or a missing `event_id`/`merchant_id` — a
 * signature can verify correctly on a payload shaped differently than expected (a future Square API
 * version adding a field this parser doesn't know about yet), and guessing at a malformed event's
 * meaning risks silently mis-triggering a sync (I7's "degrade to unknown, never guess" applied to
 * event parsing, not just business numbers).
 */
export const parseSquareWebhook = (rawBody: string): SquareParsedWebhook => {
  let envelope: SquareWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SquareWebhookEnvelope;
  } catch {
    throw new SquareWebhookParseError('not valid JSON');
  }

  if (!envelope.event_id) throw new SquareWebhookParseError('missing event_id');
  if (!envelope.merchant_id) throw new SquareWebhookParseError('missing merchant_id');
  const type = envelope.type ? SQUARE_EVENT_TYPE_MAP[envelope.type] : undefined;
  if (!type) throw new SquareWebhookParseError(`unrecognized event type '${envelope.type}'`);

  const orderRef = envelope.data?.object?.order_updated ?? envelope.data?.object?.order_fulfillment_updated;

  return {
    merchantId: envelope.merchant_id,
    event: {
      externalEventId: envelope.event_id,
      type,
      // Square's real per-order location_id when an order event carries one; falls back to the
      // merchant id itself rather than leaving this required canonical field empty — the route's
      // own connection lookup (by merchantId, not this field) is the authoritative tenant
      // resolution either way, this is downstream/display detail only.
      locationExternalId: orderRef?.location_id ?? envelope.merchant_id,
      ...(orderRef?.order_id !== undefined ? { transactionExternalId: orderRef.order_id } : {}),
    },
  };
};
