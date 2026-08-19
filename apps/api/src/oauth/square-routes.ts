import type { FastifyInstance } from 'fastify';
import { generateId } from '@retailos/domain';
import { PosConnectionRepository, StoreRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import {
  buildSquareAuthorizationUrl,
  encryptToken,
  exchangeSquareCodeForToken,
  fetchSquareLocations,
  type SquareEnvironment,
  type SquareLocation,
  type SquareOAuthConfig,
} from '@retailos/pos';
import { db, redis, sessionStore } from '../trpc/context';
import { SESSION_COOKIE_NAME } from '../auth/establish-session';
import { OAuthStateStore } from './state-store';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

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
 * `state` here carries `sessionOrgId:storeId`, not just a bare nonce — unlike Google's login flow
 * (no identity known yet, so `state` is only a CSRF nonce), Square Connect happens to an
 * ALREADY-authenticated owner/manager connecting one specific store's POS. Encoding the storeId in
 * state, then re-verifying it against the SAME session's own store access in the callback (not
 * trusting the encoded value alone), is the same "session field alone is blind to organization"
 * discipline the inventory/stocktake routers were fixed for — a stolen/replayed state value must
 * still fail the real `StoreRepository`/`canAccessStore` check in the callback, not just the
 * state-nonce check.
 */
const encodeState = (nonce: string, storeId: string): string => `${nonce}:${storeId}`;
const decodeState = (raw: string): { nonce: string; storeId: string } | null => {
  const separatorIndex = raw.indexOf(':');
  if (separatorIndex === -1) return null;
  const nonce = raw.slice(0, separatorIndex);
  const storeId = raw.slice(separatorIndex + 1);
  if (!nonce || !storeId) return null;
  return { nonce, storeId };
};

/**
 * Square OAuth connect flow, plain Fastify routes — same reasoning as
 * `registerGoogleOAuthRoutes` (a browser-redirect flow has no tRPC representation). Structurally
 * different from Google's login flow, though: Google authenticates a person logging IN (anonymous
 * -> session); Square Connect links a store's POS account to an ALREADY-authenticated owner/manager
 * (authenticated -> store integration). Both routes below require a real, valid session cookie
 * before doing anything — confirmed with the user before building, since this is the opposite
 * precondition from Google's flow.
 */
export const registerSquareOAuthRoutes = (app: FastifyInstance): void => {
  const stateStore = new OAuthStateStore(redis);

  app.get<{ Querystring: { storeId?: string } }>('/integrations/square/connect', async (request, reply) => {
    const config = readSquareConfig();
    if (!config) {
      reply.code(503).send({ error: 'Square integration is not configured on this server.' });
      return;
    }

    const token = request.cookies[SESSION_COOKIE_NAME];
    const session = token ? await sessionStore.get(token) : null;
    if (!session) {
      reply.code(401).send({ error: 'Not signed in.' });
      return;
    }

    const { storeId } = request.query;
    if (!storeId) {
      reply.code(400).send({ error: 'storeId is required.' });
      return;
    }

    // Real DB lookup scoped to organizationId BEFORE canAccessStore — canAccessStore alone is
    // blind to organization when session.storeIds is 'ALL' (the common OWNER/MANAGER case),
    // matching the fix already applied to inventory.ts/stocktake.ts's assertStoreAccess.
    const storeRepository = new StoreRepository(db, session.organizationId);
    const store = await storeRepository.findById(storeId);
    if (!store || !canAccessStore(session, storeId)) {
      reply.code(404).send({ error: 'Store not found.' });
      return;
    }

    const nonce = await stateStore.issue();
    const state = encodeState(nonce, storeId);
    reply.redirect(buildSquareAuthorizationUrl(config, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/integrations/square/callback',
    async (request, reply) => {
      const config = readSquareConfig();
      if (!config) {
        reply.code(503).send({ error: 'Square integration is not configured on this server.' });
        return;
      }

      const cookieToken = request.cookies[SESSION_COOKIE_NAME];
      const session = cookieToken ? await sessionStore.get(cookieToken) : null;
      if (!session) {
        reply.redirect(`${WEB_ORIGIN}/settings/integrations?error=square_not_signed_in`);
        return;
      }

      const { code, state, error } = request.query;

      if (error) {
        // The user declined consent on Square's side, or Square reported some other error.
        reply.redirect(`${WEB_ORIGIN}/settings/integrations?error=square_oauth_denied`);
        return;
      }

      const decoded = state ? decodeState(state) : null;
      if (!code || !decoded || !(await stateStore.consume(decoded.nonce))) {
        // Missing/malformed/replayed/expired state — treated identically regardless of which case,
        // same convention Google's callback already established (no information gained either way).
        reply.redirect(`${WEB_ORIGIN}/settings/integrations?error=square_invalid_state`);
        return;
      }

      // Re-verify the store against the SAME session's own access, not the value encoded in state
      // alone — a state value is opaque to an attacker (they can't forge one that passes
      // stateStore.consume), but re-checking here means even a captured/replayed valid state can't
      // be used to connect a DIFFERENT store than the one the current session actually owns.
      const storeRepository = new StoreRepository(db, session.organizationId);
      const store = await storeRepository.findById(decoded.storeId);
      if (!store || !canAccessStore(session, decoded.storeId)) {
        reply.redirect(`${WEB_ORIGIN}/settings/integrations?error=square_store_not_found`);
        return;
      }

      let tokenResponse;
      try {
        tokenResponse = await exchangeSquareCodeForToken(config, code);
      } catch {
        reply.redirect(`${WEB_ORIGIN}/settings/integrations?error=square_token_exchange_failed`);
        return;
      }

      let locations: SquareLocation[];
      try {
        locations = await fetchSquareLocations(config, tokenResponse.accessToken);
      } catch {
        // A connection with a working token but a failed location fetch is still a real, useful
        // connection — externalLocationId just stays null until a later sync populates it,
        // rather than discarding a token exchange that genuinely succeeded.
        locations = [];
      }

      const encryptionKey = process.env.POS_TOKEN_ENCRYPTION_KEY;
      const posConnectionRepository = new PosConnectionRepository(db, session.organizationId);
      await posConnectionRepository.upsert({
        id: generateId(),
        storeId: decoded.storeId,
        vendor: 'square',
        externalAccountId: tokenResponse.merchantId,
        ...(locations[0]?.externalId !== undefined ? { externalLocationId: locations[0].externalId } : {}),
        accessTokenCiphertext: encryptToken(tokenResponse.accessToken, encryptionKey),
        refreshTokenCiphertext: encryptToken(tokenResponse.refreshToken, encryptionKey),
        tokenExpiresAt: tokenResponse.expiresAt,
        connectedByUserId: session.userId,
      });

      reply.redirect(`${WEB_ORIGIN}/settings/integrations?connected=square`);
    }
  );
};
