import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, MissingEncryptionKeyError, TokenDecryptionError } from './token-encryption';

const KEY = 'test-encryption-key-not-a-real-secret';

describe('token-encryption', () => {
  it('round-trips a real token through encrypt then decrypt', () => {
    const plaintext = 'sq0atp-real-looking-square-access-token-value';
    const ciphertext = encryptToken(plaintext, KEY);
    expect(ciphertext).not.toContain(plaintext);
    expect(decryptToken(ciphertext, KEY)).toBe(plaintext);
  });

  it('two encryptions of the identical plaintext produce different ciphertexts (fresh IV each call)', () => {
    const plaintext = 'same-token-value';
    const first = encryptToken(plaintext, KEY);
    const second = encryptToken(plaintext, KEY);
    expect(first).not.toBe(second);
    expect(decryptToken(first, KEY)).toBe(plaintext);
    expect(decryptToken(second, KEY)).toBe(plaintext);
  });

  it('decrypting with the wrong key fails loudly, never returns garbage plaintext', () => {
    const ciphertext = encryptToken('a-real-secret', KEY);
    expect(() => decryptToken(ciphertext, 'a-completely-different-key')).toThrow(TokenDecryptionError);
  });

  it('a tampered ciphertext fails the GCM auth-tag check rather than decrypting silently wrong', () => {
    const ciphertext = encryptToken('a-real-secret', KEY);
    const parts = ciphertext.split('.');
    const tamperedCiphertextPart = (parts[1] ?? '').slice(0, -2) + 'zz';
    const tampered = [parts[0], tamperedCiphertextPart, parts[2]].join('.');
    expect(() => decryptToken(tampered, KEY)).toThrow(TokenDecryptionError);
  });

  it('a malformed envelope (wrong number of parts) is rejected explicitly', () => {
    expect(() => decryptToken('not-a-real-envelope', KEY)).toThrow(TokenDecryptionError);
  });

  it('encrypting or decrypting with no key configured throws MissingEncryptionKeyError, never silently no-ops', () => {
    expect(() => encryptToken('secret', undefined)).toThrow(MissingEncryptionKeyError);
    expect(() => decryptToken('a.b.c', undefined)).toThrow(MissingEncryptionKeyError);
  });
});
