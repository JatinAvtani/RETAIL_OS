import { describe, expect, it } from 'vitest';
import {
  hashToken,
  isTokenExpired,
  issueVerificationToken,
  passwordResetTokenExpiry,
  verificationTokenExpiry,
} from './verification-token';

describe('issueVerificationToken', () => {
  it('produces a raw token whose hash matches hashToken(raw)', () => {
    const { raw, hash } = issueVerificationToken();
    expect(hashToken(raw)).toBe(hash);
  });

  it('never returns the same raw token twice across calls', () => {
    const a = issueVerificationToken();
    const b = issueVerificationToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it('the hash is not simply the raw token (actually hashed, not passed through)', () => {
    const { raw, hash } = issueVerificationToken();
    expect(hash).not.toBe(raw);
  });
});

describe('token expiry', () => {
  it('email verification tokens expire further in the future than password reset tokens', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const emailExpiry = verificationTokenExpiry(now);
    const resetExpiry = passwordResetTokenExpiry(now);
    expect(emailExpiry.getTime()).toBeGreaterThan(resetExpiry.getTime());
  });

  it('isTokenExpired is false strictly before the expiry instant', () => {
    const expiresAt = new Date('2026-01-01T12:00:00Z');
    const justBefore = new Date('2026-01-01T11:59:59.999Z');
    expect(isTokenExpired(expiresAt, justBefore)).toBe(false);
  });

  it('isTokenExpired is true at or after the expiry instant', () => {
    const expiresAt = new Date('2026-01-01T12:00:00Z');
    expect(isTokenExpired(expiresAt, expiresAt)).toBe(true);
    expect(isTokenExpired(expiresAt, new Date('2026-01-01T12:00:01Z'))).toBe(true);
  });
});
