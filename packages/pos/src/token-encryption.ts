import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * ADR-14: spec 13 §13.3 calls for "envelope encryption, KMS-managed key" for OAuth tokens at rest.
 * A real cloud KMS (AWS KMS / GCP KMS / Azure Key Vault) requires a billing account — ruled out by
 * this codebase's no-card/no-cost hard constraint. Asked the user, confirmed: app-level AES-256-GCM
 * with a static symmetric key from an environment variable (`POS_TOKEN_ENCRYPTION_KEY`), the same
 * free/no-card pattern already used for `GOOGLE_CLIENT_SECRET`/`GEMINI_API_KEY`. This is a real,
 * deliberate deviation from the spec's key-MANAGEMENT layer (no automatic rotation, no HSM-backed
 * key protection, no per-use audit trail) — the ENCRYPTION itself (tokens never stored plaintext,
 * never logged) is unchanged and just as real as a KMS-backed version would produce.
 *
 * AES-256-GCM (not CBC or a hand-rolled scheme) — authenticated encryption, so a tampered
 * ciphertext fails decryption loudly rather than silently producing garbage plaintext. A fresh
 * random 96-bit IV per encryption call (GCM's own requirement — IV reuse under the same key breaks
 * its authentication guarantee), stored alongside the ciphertext and auth tag rather than derived,
 * since deriving it deterministically from anything predictable would reintroduce the same reuse
 * risk this scheme exists to avoid.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;

/**
 * The env var is an arbitrary-length secret string, not necessarily 32 raw bytes — SHA-256 hashing
 * it deterministically derives exactly the 256-bit key AES-256-GCM requires, the same "hash an
 * arbitrary secret into a fixed-length key" pattern used wherever a human-managed secret needs to
 * become a cryptographic key of a specific size.
 */
const deriveKey = (secret: string): Buffer => createHash('sha256').update(secret, 'utf8').digest();

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super('POS_TOKEN_ENCRYPTION_KEY is not set — cannot encrypt or decrypt POS credentials.');
    this.name = 'MissingEncryptionKeyError';
  }
}

/**
 * Format: `<iv-base64url>.<ciphertext-base64url>.<authTag-base64url>` — three self-contained
 * components in one string, so `pos_connections.access_token_ciphertext` (a single `text` column)
 * needs no separate columns for IV/tag bookkeeping.
 */
export const encryptToken = (plaintext: string, encryptionKeySecret: string | undefined): string => {
  if (!encryptionKeySecret) {
    throw new MissingEncryptionKeyError();
  }
  const key = deriveKey(encryptionKeySecret);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('base64url'), ciphertext.toString('base64url'), authTag.toString('base64url')].join('.');
};

export class TokenDecryptionError extends Error {
  constructor(cause: unknown) {
    super('POS credential decryption failed — the ciphertext is malformed or was tampered with.');
    this.name = 'TokenDecryptionError';
    this.cause = cause;
  }
}

export const decryptToken = (ciphertextEnvelope: string, encryptionKeySecret: string | undefined): string => {
  if (!encryptionKeySecret) {
    throw new MissingEncryptionKeyError();
  }
  const parts = ciphertextEnvelope.split('.');
  if (parts.length !== 3) {
    throw new TokenDecryptionError(new Error('Ciphertext envelope does not have exactly 3 parts.'));
  }
  const [ivPart, ciphertextPart, authTagPart] = parts as [string, string, string];

  try {
    const key = deriveKey(encryptionKeySecret);
    const iv = Buffer.from(ivPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    const authTag = Buffer.from(authTagPart, 'base64url');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    // GCM's own auth-tag check throws on any tampering or wrong key — never returns garbage
    // plaintext silently, which is exactly the property that makes this safe to trust.
    throw new TokenDecryptionError(err);
  }
};
