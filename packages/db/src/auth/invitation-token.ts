import { issueVerificationToken, hashToken, type IssuedToken } from './verification-token';

export type { IssuedToken };
export { hashToken };

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, per plan.md

/**
 * Same shape and entropy as an email-verification token (32 random bytes, SHA-256 hash-at-rest —
 * see verification-token.ts for why a fast hash is correct here, not Argon2id). A separate
 * function rather than reusing `issueVerificationToken` directly so invitation-specific intent is
 * clear at call sites, even though the underlying primitive is identical.
 */
export const issueInvitationToken = (): IssuedToken => issueVerificationToken();

export const invitationExpiry = (issuedAt: Date = new Date()): Date =>
  new Date(issuedAt.getTime() + INVITATION_TTL_MS);

export const isInvitationExpired = (expiresAt: Date, now: Date = new Date()): boolean => now >= expiresAt;
