import { randomBytes, createHash } from 'node:crypto';

/**
 * A verification token as handed to the user (in an email link), and its hashed form as stored in
 * the database — never the reverse. A leaked token table must not grant account access, so only
 * the hash is ever persisted; the raw token exists only in memory long enough to email it.
 */
export type IssuedToken = {
  readonly raw: string;
  readonly hash: string;
};

const TOKEN_BYTES = 32;

export const issueVerificationToken = (): IssuedToken => {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashToken(raw) };
};

/**
 * SHA-256, not Argon2id — this hash exists purely to make a stolen token table useless (the
 * token itself is already 256 bits of random entropy, nothing to slow-hash against), whereas
 * Argon2id's memory-hardness is specifically for defending low-entropy human-chosen passwords.
 * Using it here would be expensive for no security benefit.
 */
export const hashToken = (rawToken: string): string =>
  createHash('sha256').update(rawToken).digest('hex');

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h — shorter: a live account takeover path

export const verificationTokenExpiry = (issuedAt: Date = new Date()): Date =>
  new Date(issuedAt.getTime() + EMAIL_VERIFICATION_TTL_MS);

export const passwordResetTokenExpiry = (issuedAt: Date = new Date()): Date =>
  new Date(issuedAt.getTime() + PASSWORD_RESET_TTL_MS);

export const isTokenExpired = (expiresAt: Date, now: Date = new Date()): boolean => now >= expiresAt;
