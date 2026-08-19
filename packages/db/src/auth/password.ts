import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { createHash } from 'node:crypto';

/**
 * Explicit algorithm choice rather than relying on the library default — the design requires
 * Argon2id specifically (memory-hard, side-channel resistant), and a future library upgrade
 * changing its default must not silently change what this system hashes with.
 *
 * The literal `2` is `Algorithm.Argon2id` from @node-rs/argon2 — that enum is `declare const
 * enum`, which `isolatedModules` (required for this repo's strict TS config) forbids referencing
 * by value, only by type. Verified against the library's own type definitions, not guessed.
 */
const ARGON2ID: Algorithm = 2;
const HASH_OPTIONS = { algorithm: ARGON2ID };

export const hashPassword = (password: string): Promise<string> => hash(password, HASH_OPTIONS);

/**
 * Verifies against whatever algorithm/params are encoded in the stored hash string itself (Argon2
 * hashes are self-describing), not against HASH_OPTIONS — this is what lets a future parameter
 * change (e.g. raising memoryCost) apply to newly-hashed passwords without invalidating existing
 * ones.
 */
export const verifyPassword = (storedHash: string, password: string): Promise<boolean> =>
  verify(storedHash, password);

const MIN_PASSWORD_LENGTH = 12;

export type PasswordPolicyViolation = 'too_short' | 'breached';

/**
 * Length-based policy plus a k-anonymity breach check against the HIBP Pwned Passwords API — no
 * composition rules and no forced rotation.
 * Returns every violation found rather than stopping at the first, so a caller can show the user
 * everything wrong with one password in one round trip.
 */
export const checkPasswordPolicy = async (password: string): Promise<PasswordPolicyViolation[]> => {
  const violations: PasswordPolicyViolation[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    violations.push('too_short');
  }

  if (await isPasswordBreached(password)) {
    violations.push('breached');
  }

  return violations;
};

/**
 * k-anonymity: only the first 5 hex characters of the SHA-1 hash are sent to HIBP, never the
 * password or its full hash — the API returns every suffix sharing that prefix, and the match
 * happens locally. This is the documented, privacy-preserving way to query Pwned Passwords, not a
 * shortcut.
 *
 * Fails open (returns false / "not breached") on a network error rather than blocking signup —
 * this is a defense-in-depth check, not the primary password-strength gate (the length
 * requirement), and a third-party outage should not be able to lock out every new signup.
 */
const isPasswordBreached = async (password: string): Promise<boolean> => {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
    });
    if (!response.ok) {
      return false;
    }

    const body = await response.text();
    return body.split('\r\n').some((line) => line.split(':')[0] === suffix);
  } catch {
    return false;
  }
};
