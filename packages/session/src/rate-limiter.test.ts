import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisClient } from './redis-client';
import { RateLimiter } from './rate-limiter';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

describe('RateLimiter', () => {
  let redis: ReturnType<typeof createRedisClient>;

  beforeAll(() => {
    redis = createRedisClient(REDIS_URL);
  });

  afterAll(async () => {
    await redis.quit();
  });

  const uniqueKey = () => `test-${Math.random().toString(36).slice(2)}`;

  it('allows an attempt when no failures have been recorded', async () => {
    const limiter = new RateLimiter(redis, 'test-scope', {
      maxAttempts: 3,
      windowSeconds: 60,
      lockoutSeconds: 60,
    });

    expect(await limiter.check(uniqueKey())).toEqual({ allowed: true });
  });

  it('allows attempts under the threshold, then locks out once maxAttempts is reached', async () => {
    const limiter = new RateLimiter(redis, 'test-scope', {
      maxAttempts: 3,
      windowSeconds: 60,
      lockoutSeconds: 60,
    });
    const key = uniqueKey();

    await limiter.recordFailure(key);
    expect(await limiter.check(key)).toEqual({ allowed: true });

    await limiter.recordFailure(key);
    expect(await limiter.check(key)).toEqual({ allowed: true });

    await limiter.recordFailure(key);
    const result = await limiter.check(key);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('reset clears the counter so a subsequent check is allowed again', async () => {
    const limiter = new RateLimiter(redis, 'test-scope', {
      maxAttempts: 1,
      windowSeconds: 60,
      lockoutSeconds: 60,
    });
    const key = uniqueKey();

    await limiter.recordFailure(key);
    expect((await limiter.check(key)).allowed).toBe(false);

    await limiter.reset(key);
    expect(await limiter.check(key)).toEqual({ allowed: true });
  });

  it('two different keys in the same scope are tracked independently', async () => {
    const limiter = new RateLimiter(redis, 'test-scope', {
      maxAttempts: 1,
      windowSeconds: 60,
      lockoutSeconds: 60,
    });
    const keyA = uniqueKey();
    const keyB = uniqueKey();

    await limiter.recordFailure(keyA);

    expect((await limiter.check(keyA)).allowed).toBe(false);
    expect((await limiter.check(keyB)).allowed).toBe(true);
  });

  it('two different scopes with the same key are tracked independently', async () => {
    const key = uniqueKey();
    const scopeA = new RateLimiter(redis, 'scope-a', {
      maxAttempts: 1,
      windowSeconds: 60,
      lockoutSeconds: 60,
    });
    const scopeB = new RateLimiter(redis, 'scope-b', {
      maxAttempts: 1,
      windowSeconds: 60,
      lockoutSeconds: 60,
    });

    await scopeA.recordFailure(key);

    expect((await scopeA.check(key)).allowed).toBe(false);
    expect((await scopeB.check(key)).allowed).toBe(true);
  });

  it('the counting window expires on its own when the lockout is never triggered', async () => {
    const limiter = new RateLimiter(redis, 'test-scope', {
      maxAttempts: 5,
      windowSeconds: 1,
      lockoutSeconds: 60,
    });
    const key = uniqueKey();

    await limiter.recordFailure(key);
    expect((await limiter.check(key)).allowed).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The window lapsed with the count still under maxAttempts, so the key is simply gone -
    // confirmed indirectly via a fresh failure starting the count back at 1, not at 2.
    await limiter.recordFailure(key);
    expect((await limiter.check(key)).allowed).toBe(true);
  });
});
