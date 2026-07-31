import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRedisClient } from './redis-client';
import { SessionStore } from './session-store';
import type { NewSessionInput } from './session';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

const sampleInput = (overrides: Partial<NewSessionInput> = {}): NewSessionInput => ({
  userId: `user-${Math.random().toString(36).slice(2)}`,
  organizationId: 'org-1',
  storeIds: 'ALL',
  role: 'OWNER',
  permissions: ['financial:read'],
  ...overrides,
});

describe('SessionStore', () => {
  let redis: ReturnType<typeof createRedisClient>;
  let store: SessionStore;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    redis = createRedisClient(REDIS_URL);
    store = new SessionStore(redis);
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      await store.revokeAll(userId);
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('create then get returns the same session data', async () => {
    const input = sampleInput();
    createdUserIds.push(input.userId);

    const { token } = await store.create(input, '127.0.0.1', 'test-agent');
    const record = await store.get(token);

    expect(record?.userId).toBe(input.userId);
    expect(record?.organizationId).toBe(input.organizationId);
    expect(record?.role).toBe(input.role);
    expect(record?.ip).toBe('127.0.0.1');
  });

  it('get returns null for an unrecognized token', async () => {
    expect(await store.get('this-token-was-never-issued')).toBeNull();
  });

  it('revoke makes the session immediately unreadable', async () => {
    const input = sampleInput();
    createdUserIds.push(input.userId);

    const { token } = await store.create(input, '127.0.0.1', 'test-agent');
    expect(await store.get(token)).not.toBeNull();

    await store.revoke(token, input.userId);

    expect(await store.get(token)).toBeNull();
  });

  it('revokeAll invalidates every session for a user, leaving other users untouched', async () => {
    const inputA = sampleInput();
    const inputB = sampleInput({ userId: `other-${Math.random().toString(36).slice(2)}` });
    createdUserIds.push(inputA.userId, inputB.userId);

    const sessionA1 = await store.create(inputA, '127.0.0.1', 'agent-1');
    const sessionA2 = await store.create(inputA, '127.0.0.1', 'agent-2');
    const sessionB = await store.create(inputB, '127.0.0.1', 'agent-3');

    await store.revokeAll(inputA.userId);

    expect(await store.get(sessionA1.token)).toBeNull();
    expect(await store.get(sessionA2.token)).toBeNull();
    expect(await store.get(sessionB.token)).not.toBeNull();
  });

  it('listForUser returns every live session for that user and none for another', async () => {
    const inputA = sampleInput();
    const inputB = sampleInput({ userId: `other-${Math.random().toString(36).slice(2)}` });
    createdUserIds.push(inputA.userId, inputB.userId);

    const session1 = await store.create(inputA, '10.0.0.1', 'chrome');
    const session2 = await store.create(inputA, '10.0.0.2', 'firefox');
    await store.create(inputB, '10.0.0.3', 'safari');

    const listed = await store.listForUser(inputA.userId);
    const tokens = listed.map((s) => s.token);

    expect(tokens).toContain(session1.token);
    expect(tokens).toContain(session2.token);
    expect(listed).toHaveLength(2);
  });

  it('listForUser prunes a stale set entry after its session key has expired', async () => {
    const input = sampleInput();
    createdUserIds.push(input.userId);

    // A store with a near-zero idle timeout so the Redis key expires almost immediately, while
    // the user-sessions set entry (added in the same create() call) is unaffected by that TTL.
    const shortLivedStore = new SessionStore(redis, { idleTimeoutSeconds: 1 });
    const { token } = await shortLivedStore.create(input, '127.0.0.1', 'test-agent');

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const listed = await shortLivedStore.listForUser(input.userId);
    expect(listed.find((s) => s.token === token)).toBeUndefined();
  });

  it('a session past its absolute lifetime is treated as expired even before Redis TTL catches up', async () => {
    const input = sampleInput();
    createdUserIds.push(input.userId);

    // Absolute lifetime longer than the test needs to wait, but short enough to actually elapse -
    // idle timeout stays long so this isolates the absolute-cap logic specifically.
    const shortAbsoluteStore = new SessionStore(redis, { absoluteLifetimeMs: 50 });
    const { token } = await shortAbsoluteStore.create(input, '127.0.0.1', 'test-agent');

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await shortAbsoluteStore.get(token)).toBeNull();
  });

  it('get refreshes the idle TTL (sliding renewal) so an actively-used session does not idle-expire', async () => {
    const input = sampleInput();
    createdUserIds.push(input.userId);

    const slidingStore = new SessionStore(redis, { idleTimeoutSeconds: 1 });
    const { token } = await slidingStore.create(input, '127.0.0.1', 'test-agent');

    // Access it just before the 1s idle window would lapse, refreshing the TTL...
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await slidingStore.get(token)).not.toBeNull();

    // ...so 700ms later (1400ms total, past the original 1s window) it should still be alive.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await slidingStore.get(token)).not.toBeNull();
  });
});
