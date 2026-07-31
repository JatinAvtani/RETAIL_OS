import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { users, verificationTokens } from '../schema/index';
import { UserRepository } from './user-repository';
import { hashPassword } from '../auth/password';

/**
 * Real Postgres, real transactions — the property under test (single-use consumption under
 * concurrency, the same-transaction verified-at update) only means something against a real
 * database, not a mock.
 */
const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

describe('UserRepository', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repo: UserRepository;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    client = postgres(APP_CONNECTION_STRING);
    db = drizzle(client, { schema });
    repo = new UserRepository(db);
  });

  afterEach(async () => {
    for (const id of createdUserIds) {
      await db.delete(verificationTokens).where(eq(verificationTokens.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await client.end();
  });

  it('createWithVerificationToken creates an unverified user and a usable token', async () => {
    const passwordHash = await hashPassword('a-real-password-123');
    const { userId, token } = await repo.createWithVerificationToken(
      `test-${Date.now()}@example.test`,
      passwordHash
    );
    createdUserIds.push(userId);

    const user = await repo.findById(userId);
    expect(user).not.toBeNull();
    expect(user?.emailVerifiedAt).toBeNull();

    const result = await repo.verifyEmail(token.raw);
    expect(result.ok).toBe(true);
  });

  it('verifyEmail sets email_verified_at on the correct user', async () => {
    const passwordHash = await hashPassword('a-real-password-123');
    const { userId, token } = await repo.createWithVerificationToken(
      `test-${Date.now()}-verify@example.test`,
      passwordHash
    );
    createdUserIds.push(userId);

    await repo.verifyEmail(token.raw);

    const user = await repo.findById(userId);
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it('rejects an unrecognized token as invalid', async () => {
    const result = await repo.verifyEmail('this-token-was-never-issued');
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('a token cannot be consumed twice', async () => {
    const passwordHash = await hashPassword('a-real-password-123');
    const { userId, token } = await repo.createWithVerificationToken(
      `test-${Date.now()}-reuse@example.test`,
      passwordHash
    );
    createdUserIds.push(userId);

    const first = await repo.verifyEmail(token.raw);
    const second = await repo.verifyEmail(token.raw);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'invalid' });
  });

  it('concurrent verification attempts with the same token succeed exactly once', async () => {
    const passwordHash = await hashPassword('a-real-password-123');
    const { userId, token } = await repo.createWithVerificationToken(
      `test-${Date.now()}-concurrent@example.test`,
      passwordHash
    );
    createdUserIds.push(userId);

    const results = await Promise.all([
      repo.verifyEmail(token.raw),
      repo.verifyEmail(token.raw),
      repo.verifyEmail(token.raw),
    ]);

    const successes = results.filter((r) => r.ok);
    expect(successes).toHaveLength(1);
  });

  it('findByEmail finds a created user and returns null for a nonexistent one', async () => {
    const email = `test-${Date.now()}-findby@example.test`;
    const passwordHash = await hashPassword('a-real-password-123');
    const { userId } = await repo.createWithVerificationToken(email, passwordHash);
    createdUserIds.push(userId);

    expect(await repo.findByEmail(email)).not.toBeNull();
    expect(await repo.findByEmail('definitely-not-registered@example.test')).toBeNull();
  });

  it('createFromGoogle creates a pre-verified user with no password', async () => {
    const email = `test-${Date.now()}-google@example.test`;
    const googleId = `google-sub-${Date.now()}`;
    const userId = await repo.createFromGoogle(email, googleId, 'Real Name');
    createdUserIds.push(userId);

    const user = await repo.findById(userId);
    expect(user).not.toBeNull();
    expect(user?.emailVerifiedAt).not.toBeNull();
    expect(user?.passwordHash).toBeNull();
    expect(user?.googleId).toBe(googleId);
    expect(user?.name).toBe('Real Name');
  });

  it('findByGoogleId finds a created Google user and returns null for an unrecognized id', async () => {
    const googleId = `google-sub-${Date.now()}-findby`;
    const userId = await repo.createFromGoogle(
      `test-${Date.now()}-findbygoogle@example.test`,
      googleId,
      null
    );
    createdUserIds.push(userId);

    const found = await repo.findByGoogleId(googleId);
    expect(found?.id).toBe(userId);
    expect(await repo.findByGoogleId('this-google-id-was-never-issued')).toBeNull();
  });

  it('linkGoogleId attaches a Google identity to an existing password account', async () => {
    const passwordHash = await hashPassword('a-real-password-123');
    const { userId } = await repo.createWithVerificationToken(
      `test-${Date.now()}-link@example.test`,
      passwordHash
    );
    createdUserIds.push(userId);

    const googleId = `google-sub-${Date.now()}-link`;
    await repo.linkGoogleId(userId, googleId);

    const user = await repo.findById(userId);
    expect(user?.googleId).toBe(googleId);
    expect(user?.passwordHash).not.toBeNull(); // linking doesn't erase the existing password
  });

  it('two different users cannot claim the same Google id (unique constraint)', async () => {
    const googleId = `google-sub-${Date.now()}-dupe`;
    const firstUserId = await repo.createFromGoogle(
      `test-${Date.now()}-dupe1@example.test`,
      googleId,
      null
    );
    createdUserIds.push(firstUserId);

    await expect(
      repo.createFromGoogle(`test-${Date.now()}-dupe2@example.test`, googleId, null)
    ).rejects.toThrow();
  });
});
