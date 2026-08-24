import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, hashPassword, users, verificationTokens } from '@retailos/db';
import { generateId } from '@retailos/domain';
import { resolveGoogleUser } from './resolve-user';
import type { GoogleIdentity } from './google';

/**
 * Real Postgres — the account-linking/takeover-guard decisions here are exactly the kind of logic
 * that looks right on paper and is wrong under a real unique-constraint or real existing row, so
 * this is tested against the actual database, not a mocked repository.
 */
describe('resolveGoogleUser', () => {
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const createdUserIds: string[] = [];

  afterEach(async () => {
    for (const userId of createdUserIds) {
      await db.delete(verificationTokens).where(eq(verificationTokens.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  const uniqueEmail = (label: string) =>
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const identity = (overrides: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
    googleId: `google-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    email: uniqueEmail('oauth'),
    emailVerified: true,
    name: 'Real Name',
    ...overrides,
  });

  it('creates a brand-new pre-verified user when no account exists for the email or Google id', async () => {
    const result = await resolveGoogleUser(db, identity());

    expect(result.ok).toBe(true);
    if (result.ok) {
      createdUserIds.push(result.userId);
      const [user] = await db.select().from(users).where(eq(users.id, result.userId));
      expect(user?.emailVerifiedAt).not.toBeNull();
      expect(user?.passwordHash).toBeNull();
    }
  });

  it('finds the existing user by Google id on a second sign-in, without creating a duplicate', async () => {
    const google = identity();
    const first = await resolveGoogleUser(db, google);
    if (first.ok) createdUserIds.push(first.userId);

    const second = await resolveGoogleUser(db, google);

    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.userId).toBe(first.userId);
    }
  });

  it('links Google to an existing VERIFIED password account with the same email', async () => {
    const email = uniqueEmail('linkable');
    const passwordHash = await hashPassword('a-genuinely-long-password-123');
    const [existing] = await db
      .insert(users)
      .values({ id: crypto.randomUUID(), email, passwordHash, emailVerifiedAt: new Date() })
      .returning();
    createdUserIds.push(existing!.id);

    const result = await resolveGoogleUser(db, identity({ email }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(existing!.id);
      const [linked] = await db.select().from(users).where(eq(users.id, existing!.id));
      expect(linked?.googleId).not.toBeNull();
      expect(linked?.passwordHash).not.toBeNull(); // the original password still works too
    }
  });

  it('refuses to link Google to an existing UNVERIFIED password account (account-takeover guard)', async () => {
    const email = uniqueEmail('unverified');
    const passwordHash = await hashPassword('a-genuinely-long-password-123');
    const [existing] = await db
      .insert(users)
      .values({ id: crypto.randomUUID(), email, passwordHash, emailVerifiedAt: null })
      .returning();
    createdUserIds.push(existing!.id);

    const result = await resolveGoogleUser(db, identity({ email }));

    expect(result).toEqual({ ok: false, reason: 'unverified_password_account_exists' });

    const [unchanged] = await db.select().from(users).where(eq(users.id, existing!.id));
    expect(unchanged?.googleId).toBeNull();
  });

  /**
   * The abandoned-setup regression. A Google user who reaches the workspace form and closes the tab
   * has an account with no password and no membership; if a RETURNING sign-in does not route them
   * back to setup, they are locked out by every route — no password to sign in with, and the
   * membership check rejects them. The first version of this flow keyed on "was just created",
   * which fired only on the very first sign-in and left exactly this person stranded.
   */
  it('flags a returning passwordless Google user as still needing a workspace', async () => {
    const first = await resolveGoogleUser(db, identity());
    if (!first.ok) throw new Error('expected the first sign-in to succeed');
    createdUserIds.push(first.userId);
    expect(first.created).toBe(true);
    expect(first.needsWorkspace).toBe(true);

    // Same Google identity, second visit — the row now exists, so `created` is false, but the
    // account still has no password and still needs its workspace.
    const rows = await db.select().from(users).where(eq(users.id, first.userId));
    const second = await resolveGoogleUser(db, identity({ googleId: rows[0]!.googleId!, email: rows[0]!.email }));
    if (!second.ok) throw new Error('expected the second sign-in to succeed');

    expect(second.created).toBe(false);
    expect(second.needsWorkspace).toBe(true);
    expect(second.userId).toBe(first.userId);
  });

  it('does not flag an account that has a password — it can always sign in the original way', async () => {
    const email = uniqueEmail('has-password');
    const passwordHash = await hashPassword('a-genuinely-long-password-123');
    // ids are generated in application code (UUID v7), never by a column default.
    const userId = generateId();
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });
    createdUserIds.push(userId);

    const result = await resolveGoogleUser(db, identity({ email }));
    if (!result.ok) throw new Error('expected linking to succeed');

    expect(result.needsWorkspace).toBe(false);
  });
});
