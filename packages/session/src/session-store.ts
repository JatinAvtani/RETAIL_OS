import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { NewSessionInput, SessionRecord } from './session';

const DEFAULT_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_IDLE_TIMEOUT_SECONDS = 12 * 60 * 60; // 12 hours

const sessionKey = (token: string) => `session:${token}`;
const userSessionsKey = (userId: string) => `user-sessions:${userId}`;

const generateToken = (): string => randomBytes(32).toString('base64url');

export type SessionStoreOptions = {
  /** Overridable for tests — real callers should use the 30d/12h defaults from the design. */
  absoluteLifetimeMs?: number;
  idleTimeoutSeconds?: number;
};

/**
 * Server-side sessions in Redis, not JWTs — instant revocation is a hard requirement (the design's
 * ADR-10): firing a manager must cut access now, not at token expiry. Every read/write here
 * is a real round trip to Redis; there is no in-memory cache layer, so a revoked session is
 * unreadable on the very next request anywhere in the fleet, not eventually.
 *
 * Sliding idle timeout (Redis EX, refreshed via `touch`) plus a hard absolute cap
 * (`absoluteExpiresAt`, checked in application code) — Redis's own TTL alone would only give one
 * of the two: an EX that resets on every request never actually expires a permanently-active
 * session, which is why the absolute cap has to be enforced separately rather than relying on the
 * TTL to do both jobs.
 *
 * Keys are `session:<256-bit-random-token>` and `user-sessions:<userId>` — never a tenant/org
 * component, and deliberately so: a session token is unguessable and already unique per login, so
 * there's no cross-tenant collision surface a cache key normally needs organization_id to prevent.
 * The organizationId a session resolves to lives in the stored record's payload, not the lookup key.
 */
export class SessionStore {
  private readonly absoluteLifetimeMs: number;
  private readonly idleTimeoutSeconds: number;

  constructor(
    private readonly redis: Redis,
    options: SessionStoreOptions = {}
  ) {
    this.absoluteLifetimeMs = options.absoluteLifetimeMs ?? DEFAULT_ABSOLUTE_LIFETIME_MS;
    this.idleTimeoutSeconds = options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  }

  /**
   * Returns the raw token to hand to the caller (for the session cookie) — nothing about how it's
   * transported (cookie flags, `__Host-` prefix) is this class's concern, only storage.
   */
  async create(input: NewSessionInput, ip: string, userAgent: string): Promise<{ token: string }> {
    const token = generateToken();
    const now = new Date();
    const record: SessionRecord = {
      ...input,
      ip,
      userAgent,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + this.absoluteLifetimeMs).toISOString(),
    };

    await this.redis
      .multi()
      .set(sessionKey(token), JSON.stringify(record), 'EX', this.idleTimeoutSeconds)
      .sadd(userSessionsKey(input.userId), token)
      .exec();

    return { token };
  }

  /**
   * Reads a session and, if still within its absolute lifetime, refreshes the idle TTL (sliding
   * renewal) in the same call — a session that's actively being used should not idle-expire mid-use.
   * A session past its absolute lifetime is treated as gone (and actively cleaned up), even if
   * Redis's own TTL hasn't caught up yet.
   */
  async get(token: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(sessionKey(token));
    if (!raw) {
      return null;
    }

    const record = JSON.parse(raw) as SessionRecord;

    if (new Date(record.absoluteExpiresAt).getTime() <= Date.now()) {
      await this.revoke(token, record.userId);
      return null;
    }

    record.lastSeenAt = new Date().toISOString();
    await this.redis.set(sessionKey(token), JSON.stringify(record), 'EX', this.idleTimeoutSeconds);

    return record;
  }

  /** Instant revocation: the key is gone, so the very next `get` for this token returns null. */
  async revoke(token: string, userId: string): Promise<void> {
    await this.redis.multi().del(sessionKey(token)).srem(userSessionsKey(userId), token).exec();
  }

  /** Revokes every session for a user — used when a role changes or an account is disabled. */
  async revokeAll(userId: string): Promise<void> {
    const tokens = await this.redis.smembers(userSessionsKey(userId));
    if (tokens.length === 0) {
      return;
    }

    const multi = this.redis.multi();
    for (const token of tokens) {
      multi.del(sessionKey(token));
    }
    multi.del(userSessionsKey(userId));
    await multi.exec();
  }

  /**
   * Lists all live sessions for a user (for the session-list UI). Reads through the user's
   * session-id set, then fetches each record individually — filters out any token whose session
   * already expired (Redis TTL removed the key, but the set entry can lag briefly), pruning stale
   * set entries as it goes rather than leaving them to accumulate.
   */
  async listForUser(userId: string): Promise<Array<SessionRecord & { token: string }>> {
    const tokens = await this.redis.smembers(userSessionsKey(userId));
    if (tokens.length === 0) {
      return [];
    }

    const results: Array<SessionRecord & { token: string }> = [];
    const staleTokens: string[] = [];

    for (const token of tokens) {
      const raw = await this.redis.get(sessionKey(token));
      if (raw) {
        results.push({ ...(JSON.parse(raw) as SessionRecord), token });
      } else {
        staleTokens.push(token);
      }
    }

    if (staleTokens.length > 0) {
      await this.redis.srem(userSessionsKey(userId), ...staleTokens);
    }

    return results;
  }
}
