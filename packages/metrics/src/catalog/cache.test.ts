import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { buildMetricCacheKey, DEFAULT_METRIC_CACHE_TTL_SECONDS, withMetricCache } from './cache.js';
import type { MetricResult } from './types.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

const sampleResult = (overrides: Partial<MetricResult> = {}): MetricResult => ({
  metricId: 'net_revenue',
  value: '100.0000',
  unit: 'CURRENCY',
  period: { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-01-31T00:00:00Z') },
  computedAt: new Date('2026-01-31T12:00:00Z'),
  freshness: new Date('2026-01-31T12:00:00Z'),
  provenance: [{ table: 'sales_transactions', rowCount: 5 }],
  ...overrides,
});

describe('buildMetricCacheKey', () => {
  it('includes the organization id — I4, a cache hit bypasses RLS entirely', () => {
    const keyA = buildMetricCacheKey('net_revenue', 'org-a', { storeId: 's1' });
    const keyB = buildMetricCacheKey('net_revenue', 'org-b', { storeId: 's1' });
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain('org-a');
  });

  it('is stable regardless of key order in the params object', () => {
    const keyA = buildMetricCacheKey('net_revenue', 'org-1', { storeId: 's1', days: 30 });
    const keyB = buildMetricCacheKey('net_revenue', 'org-1', { days: 30, storeId: 's1' });
    expect(keyA).toBe(keyB);
  });

  it('produces a different key for different params, same metric and org', () => {
    const keyA = buildMetricCacheKey('net_revenue', 'org-1', { storeId: 's1' });
    const keyB = buildMetricCacheKey('net_revenue', 'org-1', { storeId: 's2' });
    expect(keyA).not.toBe(keyB);
  });
});

describe('withMetricCache', () => {
  let redis: Redis;
  const usedKeys: string[] = [];

  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });

  afterEach(async () => {
    for (const key of usedKeys) {
      await redis.del(key, `${key}:lock`);
    }
    usedKeys.length = 0;
  });

  afterAll(async () => {
    await redis.quit();
  });

  const uniqueParams = () => ({ testRun: `${Date.now()}-${Math.random()}` });

  it('a cache miss calls compute exactly once and returns its real result', async () => {
    const params = uniqueParams();
    const key = buildMetricCacheKey('net_revenue', 'org-miss', params);
    usedKeys.push(key);

    let computeCallCount = 0;
    const result = await withMetricCache(redis, 'net_revenue', 'org-miss', params, async () => {
      computeCallCount++;
      return sampleResult();
    });

    expect(computeCallCount).toBe(1);
    expect(result.value).toBe('100.0000');
  });

  it('a real cache hit returns the ORIGINAL computedAt/freshness, not the current time — confirmed with the user, staleness must stay honest', async () => {
    const params = uniqueParams();
    const key = buildMetricCacheKey('net_revenue', 'org-hit', params);
    usedKeys.push(key);
    const originalComputedAt = new Date('2020-01-01T00:00:00Z'); // deliberately far in the past

    await withMetricCache(redis, 'net_revenue', 'org-hit', params, async () =>
      sampleResult({ computedAt: originalComputedAt, freshness: originalComputedAt })
    );

    let computeCallCount = 0;
    const second = await withMetricCache(redis, 'net_revenue', 'org-hit', params, async () => {
      computeCallCount++;
      return sampleResult(); // would be wrong if this were ever called
    });

    expect(computeCallCount).toBe(0); // never recomputed — a real cache hit
    expect(second.computedAt.toISOString()).toBe(originalComputedAt.toISOString());
    expect(second.freshness.toISOString()).toBe(originalComputedAt.toISOString());
  });

  it('Date fields survive the real Redis round-trip as genuine Date instances, not strings', async () => {
    const params = uniqueParams();
    const key = buildMetricCacheKey('net_revenue', 'org-dates', params);
    usedKeys.push(key);

    await withMetricCache(redis, 'net_revenue', 'org-dates', params, async () => sampleResult());
    const cached = await withMetricCache(redis, 'net_revenue', 'org-dates', params, async () => sampleResult());

    expect(cached.computedAt).toBeInstanceOf(Date);
    expect(cached.period.from).toBeInstanceOf(Date);
    expect(cached.period.to).toBeInstanceOf(Date);
  });

  it('a metric-specific extension field (e.g. an anomalies array) survives the round-trip unchanged', async () => {
    const params = uniqueParams();
    const key = buildMetricCacheKey('sales_anomaly', 'org-ext', params);
    usedKeys.push(key);
    const extended = { ...sampleResult({ metricId: 'sales_anomaly' }), anomalies: [{ date: '2026-01-05', value: '50.0000', zScore: '3.1000' }] };

    await withMetricCache(redis, 'sales_anomaly', 'org-ext', params, async () => extended as MetricResult);
    const cached = await withMetricCache(redis, 'sales_anomaly', 'org-ext', params, async () => extended as MetricResult);

    expect((cached as typeof extended).anomalies).toEqual(extended.anomalies);
  });

  it('respects a real short TTL — a key genuinely expires and a later call recomputes', async () => {
    const params = uniqueParams();
    const key = buildMetricCacheKey('net_revenue', 'org-ttl', params);
    usedKeys.push(key);

    await withMetricCache(redis, 'net_revenue', 'org-ttl', params, async () => sampleResult(), 1);
    await new Promise((resolve) => setTimeout(resolve, 1300)); // past the 1s TTL

    let computeCallCount = 0;
    await withMetricCache(redis, 'net_revenue', 'org-ttl', params, async () => {
      computeCallCount++;
      return sampleResult();
    }, 1);

    expect(computeCallCount).toBe(1); // real expiry, not still cached
  });

  it('single-flight: N concurrent misses on the SAME key only compute once', async () => {
    const params = uniqueParams();
    const key = buildMetricCacheKey('net_revenue', 'org-flight', params);
    usedKeys.push(key);

    let computeCallCount = 0;
    const compute = async () => {
      computeCallCount++;
      await new Promise((resolve) => setTimeout(resolve, 200)); // simulate a real slow query
      return sampleResult();
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => withMetricCache(redis, 'net_revenue', 'org-flight', params, compute))
    );

    expect(computeCallCount).toBe(1);
    for (const result of results) {
      expect(result.value).toBe('100.0000');
    }
  });

  it('default TTL is within spec 12 §12.6\'s stated 5-60 minute range', () => {
    expect(DEFAULT_METRIC_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(5 * 60);
    expect(DEFAULT_METRIC_CACHE_TTL_SECONDS).toBeLessThanOrEqual(60 * 60);
  });
});
