import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server';
import type { FastifyInstance } from 'fastify';

/**
 * Covers everything that doesn't require a live Google OAuth exchange (there's no way to
 * automate that — it needs a real browser completing Google's own consent screen). Full
 * account-linking/creation logic is covered separately in resolve-user.test.ts against real
 * Postgres; this file proves the route wiring itself: state issuance, the authorize redirect, and
 * every error path the callback can take before it ever reaches Google.
 */
describe('Google OAuth routes', () => {
  let app: FastifyInstance;
  let originalEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    originalEnv = {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    };
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3001/auth/google/callback';

    app = buildServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('GET /auth/google redirects to the real Google authorization endpoint with a state param', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/google' });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('client_id')).toBe('test-client-id');
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:3001/auth/google/callback');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('each call to GET /auth/google issues a different, unpredictable state', async () => {
    const first = await app.inject({ method: 'GET', url: '/auth/google' });
    const second = await app.inject({ method: 'GET', url: '/auth/google' });

    const stateOf = (res: typeof first) => new URL(res.headers.location as string).searchParams.get('state');
    expect(stateOf(first)).not.toBe(stateOf(second));
  });

  it('callback redirects to a generic denial when Google reports an error (consent declined)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?error=access_denied',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?error=google_oauth_denied');
  });

  it('callback rejects a request with no state at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=some-code',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?error=google_oauth_invalid_state');
  });

  it('callback rejects a state that was never issued (forged or already consumed)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=some-code&state=this-state-was-never-issued',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?error=google_oauth_invalid_state');
  });

  it('a real, freshly-issued state can only be consumed once — replaying the callback URL fails the second time', async () => {
    const authorize = await app.inject({ method: 'GET', url: '/auth/google' });
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;

    const first = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=an-invalid-test-code&state=${state}`,
    });
    const second = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=an-invalid-test-code&state=${state}`,
    });

    // The first call consumes the state and then fails at the real Google network call (there's no
    // live Google to talk to in a test) — proving the state itself isn't the reason it failed.
    expect(first.headers.location).toBe('/login?error=google_oauth_failed');
    // The second call reuses an already-consumed state — this IS the property under test: a
    // captured/replayed callback URL cannot be used twice.
    expect(second.headers.location).toBe('/login?error=google_oauth_invalid_state');
  });
});
