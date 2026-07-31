import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { users, verificationTokens } from '../schema/index';
import {
  hashToken,
  issueVerificationToken,
  isTokenExpired,
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
}
