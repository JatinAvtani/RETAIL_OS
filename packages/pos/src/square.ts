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
