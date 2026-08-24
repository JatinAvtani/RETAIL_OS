import { afterEach, describe, expect, it } from 'vitest';
import { devOnlyToken } from './dev-only-token';

/**
 * Pins the gate on the `_devOnly*` token fields that stand in for email delivery.
 *
 * Before this gate, `requestPasswordReset` returned the raw password-reset token from a PUBLIC
 * mutation with no environment check at all — in a production deployment that hands the reset
 * secret to anyone who can name an email address.
 *
 * `NODE_ENV` is restored after each test: vitest sets it to `'test'` for the whole process, and a
 * leaked mutation here would silently change how every other suite in this file's process behaves.
 */

const original = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = original;
});

describe('devOnlyToken', () => {
  it('suppresses the token in production — the case that made this a security bug', () => {
    process.env.NODE_ENV = 'production';

    expect(devOnlyToken('raw-secret-token')).toBeUndefined();
  });

  it('returns undefined rather than null in production, so the key is omitted from the JSON response entirely', () => {
    process.env.NODE_ENV = 'production';

    const body = { message: 'ok', _devOnlyPasswordResetToken: devOnlyToken('raw-secret-token') };

    expect(JSON.stringify(body)).not.toContain('_devOnlyPasswordResetToken');
    expect(JSON.stringify(body)).not.toContain('raw-secret-token');
  });

  it('returns the token in development, where the web pages genuinely depend on it', () => {
    process.env.NODE_ENV = 'development';

    expect(devOnlyToken('raw-secret-token')).toBe('raw-secret-token');
  });

  it('returns the token under test, so the existing auth/invitation suites keep exercising real flows', () => {
    process.env.NODE_ENV = 'test';

    expect(devOnlyToken('raw-secret-token')).toBe('raw-secret-token');
  });

  it('returns the token when NODE_ENV is unset — apps/api dev is a bare `tsx watch` that sets none', () => {
    delete process.env.NODE_ENV;

    expect(devOnlyToken('raw-secret-token')).toBe('raw-secret-token');
  });

  it('passes through undefined regardless of environment — a nonexistent email never had a token to leak', () => {
    process.env.NODE_ENV = 'development';
    expect(devOnlyToken(undefined)).toBeUndefined();

    process.env.NODE_ENV = 'production';
    expect(devOnlyToken(undefined)).toBeUndefined();
  });
});
