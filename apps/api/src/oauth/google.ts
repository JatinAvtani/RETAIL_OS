const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleIdentity = {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export const buildGoogleAuthorizationUrl = (config: GoogleOAuthConfig, state: string): string => {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  // Real accounts only — the Google Cloud client is in Testing mode with a small explicit test-user
  // list, so `prompt=select_account` avoids a returning user getting silently re-signed into whatever
  // Google session happens to be active in their browser.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
};

/**
 * Exchanges the one-time authorization code for tokens, then verifies the ID token via Google's
 * own `tokeninfo` endpoint rather than checking the RS256 signature locally — no JWKS/JWT library
 * needed, at the cost of one extra network round trip per login (asked the user, chosen
 * deliberately: this project's auth volume is trivially small and the existing HIBP check already
 * establishes the same "plain fetch to a well-known verification endpoint" pattern).
 *
 * Throws on any failure (network, malformed response, audience mismatch) — the caller maps this to
 * a generic user-facing error; there is no partial-success case worth distinguishing to the caller.
 */
export const exchangeCodeForGoogleIdentity = async (
  config: GoogleOAuthConfig,
  code: string
): Promise<GoogleIdentity> => {
  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Google token exchange failed: ${tokenResponse.status}`);
  }

  const tokenBody = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenBody.id_token) {
    throw new Error('Google token exchange response had no id_token');
  }

  const tokenInfoUrl = new URL(TOKENINFO_ENDPOINT);
  tokenInfoUrl.searchParams.set('id_token', tokenBody.id_token);
  const tokenInfoResponse = await fetch(tokenInfoUrl);

  if (!tokenInfoResponse.ok) {
    throw new Error(`Google tokeninfo verification failed: ${tokenInfoResponse.status}`);
  }

  const claims = (await tokenInfoResponse.json()) as {
    aud?: string;
    sub?: string;
    email?: string;
    email_verified?: string;
    name?: string;
  };

  if (claims.aud !== config.clientId) {
    // The token wasn't issued for this app — this is exactly what audience verification exists to
    // catch, and skipping it would mean accepting a token minted for a completely different client.
    throw new Error('Google ID token audience mismatch');
  }
  if (!claims.sub || !claims.email) {
    throw new Error('Google ID token missing required claims');
  }

  return {
    googleId: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === 'true',
    name: claims.name ?? null,
  };
};
