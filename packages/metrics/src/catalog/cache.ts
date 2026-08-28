import type { Redis } from 'ioredis';
import type { MetricResult } from './types.js';

/**
 * Metric result caching. Spec's own design assumes fact tables (earlier work,
 * not built) and a real outbox relay (no such process exists anywhere in this codebase — see
 * `packages/db/src/schema/outbox-events.ts`'s own doc comment) driving event-based invalidation
 * (`cost.updated` → drop margin keys). Confirmed with the user: build TTL-only caching now, defer
 * event-driven invalidation until a real outbox relay exists for some other reason — recorded as
 * ADR-17 (`docs/spec/18-engineering-decisions.md`), not a silent shortcut.
 *
 * One flat default TTL for every metric (confirmed with the user over per-domain tiers) — 60
 * registered metrics span very different real volatility, but nothing has been cached before this
 * task, so there is no observed evidence yet for which specific metrics need a shorter/longer
 * window. Tune later if a real staleness complaint surfaces, not speculatively now.
 */

export const DEFAULT_METRIC_CACHE_TTL_SECONDS = 600; // 10 minutes — spec's own 5–60 min range

/**
 * Deterministic JSON serialization: keys sorted at EVERY nesting level, recursively — unlike
 * `JSON.stringify(value, Object.keys(value).sort())`, which looks like a sort but is actually the
 * replacer-ARRAY overload (an allowlist, not a comparator), and applies that SAME top-level-only
 * key list at every nesting level. Proven live: `{filters:{productId:'p1'}}` and
 * `{filters:{productId:'p2'}}` both serialized to `{"filters":{}}` under the old code — two
 * different params silently sharing one cache key. This function actually recurses, so nested
 * params are distinguished (and included at all).
 */
const canonicalStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`;
};

/**
 * Everything a cache key needs to be unique per real, distinguishable request — I4:
 * `organizationId` is ALWAYS part of the key, since a cache hit bypasses RLS entirely (a missing
 * org id here is a real cross-tenant leak, not a cosmetic bug). `storeIds` is included for the same
 * reason: a metric that reads `ctx.storeIds` must not serve a cache hit computed for a different
 * store scope just because `params` happened to match.
 */
export const buildMetricCacheKey = (metricId: string, organizationId: string, storeIds: string[] | 'ALL', params: unknown): string => {
  const storeIdsKey = storeIds === 'ALL' ? 'ALL' : [...storeIds].sort().join(',');
  return `metrics:v1:${organizationId}:${metricId}:${storeIdsKey}:${canonicalStringify(params)}`;
};

/**
 * `MetricResult.computedAt`/`freshness`/`period.from`/`period.to` are real `Date` objects — a
 * plain `JSON.stringify`/`JSON.parse` round-trip turns them into strings on the way in and never
 * revives them back to `Date` on the way out, which would silently corrupt every cached result's
 * timestamp fields. Metric-specific extensions (e.g. `AnomalyMetricResult`'s `anomalies` array,
 * `MarginAttributionMetricResult`'s effect fields) are preserved as-is since they carry no `Date`
 * fields of their own — confirmed by reading every extended result type in this package.
 */
const serialize = (result: MetricResult): string => JSON.stringify(result);

const deserialize = (raw: string): MetricResult => {
  const parsed = JSON.parse(raw) as MetricResult;
  return {
    ...parsed,
    computedAt: new Date(parsed.computedAt),
    freshness: new Date(parsed.freshness),
    period: { from: new Date(parsed.period.from), to: new Date(parsed.period.to) },
  };
};

const LOCK_TTL_MS = 5000;
const LOCK_POLL_INTERVAL_MS = 50;
const LOCK_MAX_WAIT_MS = 4000;

/**
 * Single-flight: when many concurrent callers miss the cache for the SAME key, only one actually
 * runs `compute` — the rest short-poll for its result to land, falling back to computing
 * themselves only if the lock holder appears to have died (no result within `LOCK_MAX_WAIT_MS`,
 * e.g. it crashed mid-computation) rather than waiting forever. `SET key value NX PX` is one atomic
 * Redis command — the lock acquisition itself can never race two callers into both believing they
 * hold it.
 *
 * `organizationId` is a real, separate parameter (not just relied on via `cacheKey`'s own prefix)
 * so the LOCK key itself is explicitly tenant-namespaced in its own right, keeping I4's tenant
 * scoping textually visible right at this Redis call site rather than only provable one call frame
 * up in `buildMetricCacheKey`.
 */
const withSingleFlight = async (
  redis: Redis,
  cacheKey: string,
  organizationId: string,
  ttlSeconds: number,
  compute: () => Promise<MetricResult>
): Promise<MetricResult> => {
  const lockKey = `metrics:v1:${organizationId}:lock:${cacheKey}`;
  const acquired = await redis.set(lockKey, '1', 'PX', LOCK_TTL_MS, 'NX');

  if (acquired === 'OK') {
    try {
      const result = await compute();
      await redis.set(cacheKey, serialize(result), 'EX', ttlSeconds);
      return result;
    } finally {
      await redis.del(lockKey);
    }
  }

  // Someone else holds the lock — short-poll for their result rather than also computing.
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return deserialize(cached);
    const stillLocked = await redis.exists(lockKey);
    if (!stillLocked) break; // lock holder finished (or died) without ever writing a result — compute ourselves
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }

  // Timed out waiting, or the lock holder vanished with no result — compute directly, no lock
  // (a second concurrent stampede here is a rare double-compute, not a correctness bug).
  return compute();
};

/**
 * The real cache-or-compute path `executeMetric` calls when a Redis client is present in
 * `MetricContext`. Returns `compute()`'s result UNCHANGED on a cache miss/write — caching is
 * purely a performance layer, never altering what value is returned (I1/I2 boundary: caching must
 * not become a second place a number could come out different).
 */
export const withMetricCache = async (
  redis: Redis,
  metricId: string,
  organizationId: string,
  storeIds: string[] | 'ALL',
  params: unknown,
  compute: () => Promise<MetricResult>,
  ttlSeconds: number = DEFAULT_METRIC_CACHE_TTL_SECONDS
): Promise<MetricResult> => {
  const cacheKey = buildMetricCacheKey(metricId, organizationId, storeIds, params);
  const cached = await redis.get(cacheKey);
  if (cached !== null) return deserialize(cached);
  return withSingleFlight(redis, cacheKey, organizationId, ttlSeconds, compute);
};
