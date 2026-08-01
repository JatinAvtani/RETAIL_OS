import type { Redis } from 'ioredis';

const rateLimitKey = (scope: string, key: string) => `rate-limit:${scope}:${key}`;

export type RateLimiterOptions = {
  /** Failures allowed within `windowSeconds` before the scope+key is locked out. */
  maxAttempts: number;
  /** Rolling window: the counter's own TTL, reset on every failure (fixed-window-per-burst). */
  windowSeconds: number;
  /** How long a lockout lasts once `maxAttempts` is exceeded. */
  lockoutSeconds: number;
};

export type RateLimitCheck =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Spec 14 §14.2: "Rate limiting on auth endpoints: per IP, per account, with progressive delay and
 * lockout." Two independent `RateLimiter` instances cover the two scopes (see
 * apps/api/src/auth/rate-limit.ts) — this class itself is generic over one scope+key pair, matching
 * `SessionStore`/`OAuthStateStore`'s existing pattern of a thin class wrapping one Redis key shape.
 *
 * "Progressive" is implemented as a hard lockout once `maxAttempts` is exceeded within the window,
 * not a slowed-down response — delaying inside a request handler ties up a connection for the
 * duration of the delay, which is a self-inflicted resource cost under exactly the load this
 * exists to defend against. A caller past the threshold is rejected immediately with
 * `retryAfterSeconds` telling them when the lockout lifts; the delay is enforced by the client
 * having to wait and retry, not by the server holding an open connection.
 *
 * `key` is caller-chosen (an IP address, or a normalized-lowercased email) — this class has no
 * opinion on tenancy, so it's excluded from the invariant scanner's I4 cache-key rule alongside
 * `session-store.ts`/`oauth/state-store.ts`: an auth attempt has no organization_id yet by
 * definition (that's what's being resolved), so there's no cross-tenant collision surface here.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly scope: string,
    private readonly options: RateLimiterOptions
  ) {}

  /** Call before attempting the operation. Does not itself count as an attempt. */
  async check(key: string): Promise<RateLimitCheck> {
    const redisKey = rateLimitKey(this.scope, key);
    const count = await this.redis.get(redisKey);

    if (count !== null && Number(count) >= this.options.maxAttempts) {
      const ttl = await this.redis.ttl(redisKey);
      return { allowed: false, retryAfterSeconds: Math.max(ttl, 1) };
    }

    return { allowed: true };
  }

  /**
   * Records a failed attempt, extending the key's TTL to `lockoutSeconds` once the count crosses
   * `maxAttempts` so the lockout genuinely outlasts the attempt-counting window (a failure at
   * attempt 5 shouldn't unlock again after the original, shorter counting window expires).
   */
  async recordFailure(key: string): Promise<void> {
    const redisKey = rateLimitKey(this.scope, key);
    const count = await this.redis.incr(redisKey);

    if (count === 1) {
      await this.redis.expire(redisKey, this.options.windowSeconds);
    } else if (count >= this.options.maxAttempts) {
      await this.redis.expire(redisKey, this.options.lockoutSeconds);
    }
  }

  /** Clears the counter — called on a successful attempt so a real login isn't penalized later. */
  async reset(key: string): Promise<void> {
    await this.redis.del(rateLimitKey(this.scope, key));
  }
}
