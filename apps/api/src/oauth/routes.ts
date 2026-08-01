import type { FastifyInstance } from 'fastify';
import { authRateLimiters, db, redis, sessionStore } from '../trpc/context';
import { establishSessionForUser, setSessionCookie } from '../auth/establish-session';
import { enforceSignupRateLimit, recordSignupAttempt } from '../auth/rate-limit';
import { OAuthStateStore } from './state-store';
import { resolveGoogleUser } from './resolve-user';
import { buildGoogleAuthorizationUrl, exchangeCodeForGoogleIdentity, type GoogleOAuthConfig } from './google';

const readGoogleConfig = (): GoogleOAuthConfig | null => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
};

/**
 * Plain Fastify routes, not tRPC procedures — OAuth is a sequence of browser redirects (302s),
 * which tRPC has no way to express; every other auth endpoint is a JSON POST, but this one
 * genuinely can't be. Registered directly on the Fastify instance in server.ts, sharing the same
 * db/redis/sessionStore singletons the tRPC context uses (see trpc/context.ts) rather than opening
 * a second set of connections.
 */
export const registerGoogleOAuthRoutes = (app: FastifyInstance): void => {
  const stateStore = new OAuthStateStore(redis);

  app.get('/auth/google', async (_request, reply) => {
    const config = readGoogleConfig();
    if (!config) {
      // Not a user-facing failure mode in practice (this only happens if the environment is
      // misconfigured), but 503 rather than a 500/crash — the route exists, the *feature* doesn't.
      reply.code(503).send({ error: 'Google sign-in is not configured on this server.' });
      return;
    }

    const state = await stateStore.issue();
    reply.redirect(buildGoogleAuthorizationUrl(config, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/google/callback',
    async (request, reply) => {
      const config = readGoogleConfig();
      if (!config) {
        reply.code(503).send({ error: 'Google sign-in is not configured on this server.' });
        return;
      }

      // Per-IP only (spec 14 §14.2): no account identity is known until the code exchange below
      // succeeds, so there's nothing to key a per-account scope on yet at this point in the flow.
      // Reuses the signup scope's IP limiter rather than the login one, since this endpoint has the
      // same "no known account yet" shape signup does, not login's "known account, bad credential" one.
      await enforceSignupRateLimit(authRateLimiters, request.ip);

      const { code, state, error } = request.query;

      if (error) {
        await recordSignupAttempt(authRateLimiters, request.ip);
        // The user declined consent, or Google reported some other error — nothing to recover,
        // just send them back to a plain sign-in page rather than showing a raw query-string error.
        reply.redirect('/login?error=google_oauth_denied');
        return;
      }

      if (!code || !state || !(await stateStore.consume(state))) {
        await recordSignupAttempt(authRateLimiters, request.ip);
        // Missing/replayed/expired state — treated identically to a denied consent from the
        // caller's point of view (no information gained either way about which case it was).
        reply.redirect('/login?error=google_oauth_invalid_state');
        return;
      }

      let identity;
      try {
        identity = await exchangeCodeForGoogleIdentity(config, code);
      } catch {
        await recordSignupAttempt(authRateLimiters, request.ip);
        reply.redirect('/login?error=google_oauth_failed');
        return;
      }

      const resolved = await resolveGoogleUser(db, identity);
      if (!resolved.ok) {
        await recordSignupAttempt(authRateLimiters, request.ip);
        reply.redirect('/login?error=verify_password_account_first');
        return;
      }

      const result = await establishSessionForUser(
        db,
        sessionStore,
        resolved.userId,
        identity.email,
        request.ip,
        request.headers['user-agent'] ?? 'unknown',
      );

      if (!result.ok) {
        if (result.reason !== 'multiple_organizations') {
          await recordSignupAttempt(authRateLimiters, request.ip);
        }
        const errorCode =
          result.reason === 'multiple_organizations' ? 'multiple_organizations' : 'no_membership';
        reply.redirect(`/login?error=${errorCode}`);
        return;
      }

      await authRateLimiters.perIp.reset(request.ip);
      setSessionCookie(reply, result.token);
      reply.redirect('/');
    }
  );
};
