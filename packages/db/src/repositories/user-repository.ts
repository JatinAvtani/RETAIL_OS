import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { users, verificationTokens } from '../schema/index';
import {
  hashToken,
  issueVerificationToken,
  isTokenExpired,
  passwordResetTokenExpiry,
  verificationTokenExpiry,
  type IssuedToken,
} from '../auth/verification-token';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Not a TenantScopedRepository: `users` has no organization_id (global identity, see
 * schema/users.ts) — there is no tenant to scope to. Cross-account isolation here isn't a
 * row-filtering concern the way tenant isolation is; it's "a user can only act as themselves,"
 * enforced by session/auth context at the call site, not by this repository.
 */
export class UserRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)));
    return rows[0] ?? null;
  }

  async findById(id: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)));
    return rows[0] ?? null;
  }

  async findByGoogleId(googleId: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.googleId, googleId), isNull(users.deletedAt)));
    return rows[0] ?? null;
  }

  /**
   * A brand-new account arriving via Google, not linked to any existing user. Pre-verified: Google
   * already confirmed this email belongs to whoever is signing in, so there is no separate
   * verification step to gate on (unlike password signup, where the email is only a claim until
   * proven). No password_hash — this account can only ever sign in via Google unless it later sets
   * one through a password-reset-shaped flow, which doesn't exist yet.
   */
  async createFromGoogle(email: string, googleId: string, name: string | null) {
    const userId = generateId();
    await this.db.insert(users).values({
      id: userId,
      email,
      name,
      googleId,
      emailVerifiedAt: new Date(),
    });
    return userId;
  }

  /**
   * Attaches a Google identity to an existing, already-verified user — the "log in with Google for
   * the first time on an account you originally created with a password" case. Never called for an
   * unverified account: that would let anyone claiming a matching Google email silently take it
   * over before the real owner ever proved they controlled the address (the account-takeover path
   * plan.md calls out explicitly).
   */
  async linkGoogleId(userId: string, googleId: string) {
    await this.db.update(users).set({ googleId }).where(eq(users.id, userId));
  }

  /**
   * Creates an unverified user and issues an email-verification token in one call, since a
   * signup without a way to verify the email is an incomplete signup. Returns the raw token
   * (never persisted) so the caller can send it — the caller is responsible for actually
   * emailing it; this repository has no knowledge of email delivery.
   */
  async createWithVerificationToken(
    email: string,
    passwordHash: string
  ): Promise<{ userId: string; token: IssuedToken }> {
    const userId = generateId();

    await this.db.insert(users).values({
      id: userId,
      email,
      passwordHash,
    });

    const token = await this.issueVerificationTokenFor(userId);

    return { userId, token };
  }

  async issueVerificationTokenFor(userId: string): Promise<IssuedToken> {
    const token = issueVerificationToken();

    await this.db.insert(verificationTokens).values({
      id: generateId(),
      userId,
      purpose: 'email_verification',
      tokenHash: token.hash,
      expiresAt: verificationTokenExpiry(),
    });

    return token;
  }

  /**
   * Consumes a raw verification token: looks it up by hash, rejects if already used or expired,
   * marks it used and sets email_verified_at — all in one transaction, so a token can never be
   * consumed twice even under concurrent requests (the UPDATE ... WHERE used_at IS NULL only
   * succeeds for the first caller).
   */
  async verifyEmail(rawToken: string): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'expired' }> {
    const tokenHash = hashToken(rawToken);

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(verificationTokens)
        .where(
          and(
            eq(verificationTokens.tokenHash, tokenHash),
            eq(verificationTokens.purpose, 'email_verification'),
            isNull(verificationTokens.usedAt)
          )
        );
      const record = rows[0];

      if (!record) {
        return { ok: false, reason: 'invalid' } as const;
      }
      if (isTokenExpired(record.expiresAt)) {
        return { ok: false, reason: 'expired' } as const;
      }

      const consumed = await tx
        .update(verificationTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(verificationTokens.id, record.id), isNull(verificationTokens.usedAt)))
        .returning({ id: verificationTokens.id });

      if (consumed.length === 0) {
        // Another concurrent request consumed it between the SELECT and this UPDATE.
        return { ok: false, reason: 'invalid' } as const;
      }

      await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, record.userId));

      return { ok: true } as const;
    });
  }

  /**
   * Issues a password-reset token for a user, if one exists with a password to reset (an
   * OAuth-only account has no `passwordHash` — a reset flow makes no sense for it, since there is
   * no password to replace, and silently creating one would be a surprising side channel for
   * setting a password on an account that never had one). Returns `null` for both "no such email"
   * and "OAuth-only account" so the caller can give an identical, enumeration-safe response either
   * way — the same posture signup already uses for "email already registered."
   */
  async requestPasswordReset(email: string): Promise<IssuedToken | null> {
    const user = await this.findByEmail(email);
    if (!user || !user.passwordHash) {
      return null;
    }

    const token = issueVerificationToken();
    await this.db.insert(verificationTokens).values({
      id: generateId(),
      userId: user.id,
      purpose: 'password_reset',
      tokenHash: token.hash,
      expiresAt: passwordResetTokenExpiry(),
    });

    return token;
  }

  /**
   * Consumes a raw password-reset token and sets the new password hash — same single-use,
   * transactional consumption shape as `verifyEmail`, so a token can never be replayed even under
   * concurrent requests. Returns the userId on success so the caller (the tRPC procedure) can
   * revoke all of that user's existing sessions — a password reset should kill any session an
   * attacker already holds, not just block future logins with the old password. This repository
   * has no dependency on `packages/session`, so it deliberately does not revoke sessions itself.
   */
  async resetPassword(
    rawToken: string,
    newPasswordHash: string
  ): Promise<{ ok: true; userId: string } | { ok: false; reason: 'invalid' | 'expired' }> {
    const tokenHash = hashToken(rawToken);

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(verificationTokens)
        .where(
          and(
            eq(verificationTokens.tokenHash, tokenHash),
            eq(verificationTokens.purpose, 'password_reset'),
            isNull(verificationTokens.usedAt)
          )
        );
      const record = rows[0];

      if (!record) {
        return { ok: false, reason: 'invalid' } as const;
      }
      if (isTokenExpired(record.expiresAt)) {
        return { ok: false, reason: 'expired' } as const;
      }

      const consumed = await tx
        .update(verificationTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(verificationTokens.id, record.id), isNull(verificationTokens.usedAt)))
        .returning({ id: verificationTokens.id });

      if (consumed.length === 0) {
        return { ok: false, reason: 'invalid' } as const;
      }

      await tx.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, record.userId));

      return { ok: true, userId: record.userId } as const;
    });
  }
}
