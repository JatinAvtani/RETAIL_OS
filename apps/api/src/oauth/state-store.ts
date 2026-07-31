import { randomBytes } from 'node:crypto';
import type { createRedisClient } from '@retailos/session';

type Redis = ReturnType<typeof createRedisClient>;

const STATE_TTL_SECONDS = 10 * 60; // 10 minutes — long enough for a real user to complete Google's consent screen.

const stateKey = (state: string) => `oauth-state:${state}`;

/**
 * A short-lived, single-use nonce for the OAuth `state` parameter — the standard CSRF defense for
 * the authorization-code flow: without it, an attacker could trick a victim's browser into
 * completing an OAuth callback the attacker initiated, linking the attacker's Google account to
 * the victim's session. Deliberately separate from `packages/session`'s `SessionStore`: this has
 * no user identity yet (it exists specifically for the window *before* one is established) and a
 * completely different lifetime (minutes, not days).
 *
 * Keys are `oauth-state:<256-bit-random-nonce>` — excluded from the invariant scanner's I4
 * cache-key rule (scripts/verify-invariants.sh) alongside session-store.ts's keys, for the same
 * reason: no organizationId exists yet at this point in the flow to leak, so there's no
 * cross-tenant collision surface for that rule to catch.
 */
export class OAuthStateStore {
  constructor(private readonly redis: Redis) {}

  async issue(): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await this.redis.set(stateKey(state), '1', 'EX', STATE_TTL_SECONDS);
    return state;
  }

  /** Single-use: consumes the state atomically so a captured callback URL can't be replayed. */
  async consume(state: string): Promise<boolean> {
    const removed = await this.redis.del(stateKey(state));
    return removed === 1;
  }
}
