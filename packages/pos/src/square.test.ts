import { describe, expect, it } from 'vitest';
import { buildSquareAuthorizationUrl, type SquareOAuthConfig } from './square';

const sandboxConfig: SquareOAuthConfig = {
  applicationId: 'sq0idp-test-app-id',
  applicationSecret: 'sq0csp-test-secret',
  redirectUri: 'http://localhost:3001/integrations/square/callback',
  environment: 'sandbox',
};

describe('buildSquareAuthorizationUrl', () => {
  it('targets the sandbox host, not production, when environment is sandbox', () => {
    const url = new URL(buildSquareAuthorizationUrl(sandboxConfig, 'a-state-value'));
    expect(url.origin).toBe('https://connect.squareupsandbox.com');
    expect(url.pathname).toBe('/oauth2/authorize');
  });

  it('targets the production host when environment is production', () => {
    const url = new URL(buildSquareAuthorizationUrl({ ...sandboxConfig, environment: 'production' }, 'a-state-value'));
    expect(url.origin).toBe('https://connect.squareup.com');
  });

  it('carries client_id, redirect_uri, state, and session=false — no response_type param exists on this endpoint', () => {
    const url = new URL(buildSquareAuthorizationUrl(sandboxConfig, 'csrf-nonce-123'));
    expect(url.searchParams.get('client_id')).toBe(sandboxConfig.applicationId);
    expect(url.searchParams.get('redirect_uri')).toBe(sandboxConfig.redirectUri);
    expect(url.searchParams.get('state')).toBe('csrf-nonce-123');
    expect(url.searchParams.get('session')).toBe('false');
    expect(url.searchParams.has('response_type')).toBe(false);
  });

  it('requests only the minimal read-only scopes this codebase actually needs', () => {
    const url = new URL(buildSquareAuthorizationUrl(sandboxConfig, 'state'));
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toEqual(['MERCHANT_PROFILE_READ', 'ITEMS_READ', 'ORDERS_READ']);
  });
});
