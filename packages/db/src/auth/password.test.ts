import { describe, expect, it, vi, afterEach } from 'vitest';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './password';

describe('hashPassword / verifyPassword', () => {
  it('produces an Argon2id hash, not a different algorithm', async () => {
    const hash = await hashPassword('a-real-password-123');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('verifies the correct password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'correct-horse-battery-staple')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('produces different hashes for the same password (random salt per call)', async () => {
    const a = await hashPassword('same-password-both-times');
    const b = await hashPassword('same-password-both-times');
    expect(a).not.toBe(b);
  });
});

describe('checkPasswordPolicy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flags a password under 12 characters as too_short', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
    );
    const violations = await checkPasswordPolicy('short1');
    expect(violations).toContain('too_short');
  });

  it('does not flag a 12+ character password as too_short', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') })
    );
    const violations = await checkPasswordPolicy('a-long-enough-password');
    expect(violations).not.toContain('too_short');
  });

  it('flags a password whose SHA-1 suffix appears in the HIBP range response as breached', async () => {
    // SHA-1("password123") = CBFDAC6008F9CAB4083784CBD1874F76618D2A97
    // prefix = CBFDA, suffix = C6008F9CAB4083784CBD1874F76618D2A97
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('C6008F9CAB4083784CBD1874F76618D2A97:12345\r\nOTHERSUFFIX:1'),
      })
    );
    const violations = await checkPasswordPolicy('password123');
    expect(violations).toContain('breached');
  });

  it('does not flag a password whose suffix is absent from the HIBP range response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('SOMEOTHERSUFFIX:1\r\nANOTHERSUFFIX:2'),
      })
    );
    const violations = await checkPasswordPolicy('a-long-enough-unbreached-password');
    expect(violations).not.toContain('breached');
  });

  it('fails open (no breached violation) when the HIBP API call throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const violations = await checkPasswordPolicy('a-long-enough-password-network-down');
    expect(violations).not.toContain('breached');
  });

  it('fails open (no breached violation) when the HIBP API returns a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('') }));
    const violations = await checkPasswordPolicy('a-long-enough-password-api-down');
    expect(violations).not.toContain('breached');
  });
});
