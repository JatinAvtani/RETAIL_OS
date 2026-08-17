import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import Redis from 'ioredis';
import type { AuthContext } from '@retailos/authz';
import {
  DuplicateMetricIdError,
  MetricPermissionDeniedError,
  UnknownMetricError,
  _resetRegistryForTests,
  defineMetric,
  executeMetric,
  getMetric,
  listMetricIds,
} from './registry.js';
import type { MetricContext, MetricResult } from './types.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Mechanics tests for the catalog itself — registration validation, the single execution path,
 * and permission enforcement. These use their own throwaway metric ids and reset the registry
 * before/after each test, since the real margin metrics register once at module-import time and
 * are exercised by `packages/metrics/src/margin/catalog-entries.test.ts` instead.
 */
describe('metric catalog registry', () => {
  const auth = (permissions: AuthContext['permissions']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org1',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions,
  });

  const ctx: MetricContext = { db: {} as MetricContext['db'], organizationId: 'org1', storeIds: 'ALL' };

  it('registers a well-formed metric and makes it discoverable', () => {
    _resetRegistryForTests();
    const def = defineMetric({
      id: 'test_metric_a',
      description: 'A test metric.',
      parameters: z.object({}),
      unit: 'COUNT',
      requiredPermission: 'financial:read',
      sources: ['some_table'],
      async execute(): Promise<MetricResult> {
        return {
          metricId: 'test_metric_a',
          value: '1',
          unit: 'COUNT',
          period: { from: new Date(), to: new Date() },
          computedAt: new Date(),
          freshness: new Date(),
          provenance: [],
        };
      },
    });
    expect(getMetric('test_metric_a')).toBe(def);
    expect(listMetricIds()).toContain('test_metric_a');
  });

  it('rejects a second registration under the same id', () => {
    _resetRegistryForTests();
    const shape = {
      description: 'x',
      parameters: z.object({}),
      unit: 'COUNT' as const,
      requiredPermission: 'financial:read' as const,
      sources: ['t'],
      async execute(): Promise<MetricResult> {
        return {
          metricId: 'dup',
          value: '1',
          unit: 'COUNT',
          period: { from: new Date(), to: new Date() },
          computedAt: new Date(),
          freshness: new Date(),
          provenance: [],
        };
      },
    };
    defineMetric({ id: 'dup', ...shape });
    expect(() => defineMetric({ id: 'dup', ...shape })).toThrow(DuplicateMetricIdError);
  });

  it('rejects a metric with no declared sources', () => {
    _resetRegistryForTests();
    expect(() =>
      defineMetric({
        id: 'no_sources',
        description: 'x',
        parameters: z.object({}),
        unit: 'COUNT',
        requiredPermission: 'financial:read',
        sources: [],
        async execute(): Promise<MetricResult> {
          throw new Error('unreachable');
        },
      })
    ).toThrow(/at least one source/);
  });

  it('executeMetric throws UnknownMetricError for an unregistered id', async () => {
    _resetRegistryForTests();
    await expect(executeMetric('nonexistent', {}, auth(new Set(['financial:read'])), ctx)).rejects.toThrow(
      UnknownMetricError
    );
  });

  it('executeMetric refuses a caller lacking the required permission — BEFORE execute ever runs', async () => {
    _resetRegistryForTests();
    let executed = false;
    defineMetric({
      id: 'gated_metric',
      description: 'x',
      parameters: z.object({}),
      unit: 'COUNT',
      requiredPermission: 'financial:read',
      sources: ['t'],
      async execute(): Promise<MetricResult> {
        executed = true;
        return {
          metricId: 'gated_metric',
          value: '1',
          unit: 'COUNT',
          period: { from: new Date(), to: new Date() },
          computedAt: new Date(),
          freshness: new Date(),
          provenance: [],
        };
      },
    });

    await expect(executeMetric('gated_metric', {}, auth(new Set()), ctx)).rejects.toThrow(
      MetricPermissionDeniedError
    );
    expect(executed).toBe(false);
  });

  it('executeMetric validates params against the Zod schema before calling execute', async () => {
    _resetRegistryForTests();
    defineMetric({
      id: 'strict_params',
      description: 'x',
      parameters: z.object({ storeId: z.string().uuid() }),
      unit: 'COUNT',
      requiredPermission: 'financial:read',
      sources: ['t'],
      async execute(): Promise<MetricResult> {
        return {
          metricId: 'strict_params',
          value: '1',
          unit: 'COUNT',
          period: { from: new Date(), to: new Date() },
          computedAt: new Date(),
          freshness: new Date(),
          provenance: [],
        };
      },
    });

    await expect(
      executeMetric('strict_params', { storeId: 'not-a-uuid' }, auth(new Set(['financial:read'])), ctx)
    ).rejects.toThrow();
  });

  it('a metric that cannot compute its value returns unknown with a reason, never a fabricated number', async () => {
    _resetRegistryForTests();
    defineMetric({
      id: 'unknowable_metric',
      description: 'x',
      parameters: z.object({}),
      unit: 'CURRENCY',
      requiredPermission: 'financial:read',
      sources: ['t'],
      async execute(): Promise<MetricResult> {
        return {
          metricId: 'unknowable_metric',
          value: 'unknown',
          unit: 'CURRENCY',
          period: { from: new Date(), to: new Date() },
          computedAt: new Date(),
          freshness: new Date(),
          provenance: [],
          unknownReason: 'No data in the period.',
        };
      },
    });

    const result = await executeMetric('unknowable_metric', {}, auth(new Set(['financial:read'])), ctx);
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBe('No data in the period.');
  });

  describe('executeMetric with a real Redis cache (009-12)', () => {
    const redis = new Redis(REDIS_URL);

    afterAll(async () => {
      await redis.quit();
    });

    it('with no cache field on ctx, behaves exactly as before — every call recomputes', async () => {
      _resetRegistryForTests();
      let executed = 0;
      defineMetric({
        id: 'no_cache_metric',
        description: 'x',
        parameters: z.object({}),
        unit: 'COUNT',
        requiredPermission: 'financial:read',
        sources: ['t'],
        async execute(): Promise<MetricResult> {
          executed++;
          return {
            metricId: 'no_cache_metric',
            value: '1',
            unit: 'COUNT',
            period: { from: new Date(), to: new Date() },
            computedAt: new Date(),
            freshness: new Date(),
            provenance: [],
          };
        },
      });

      await executeMetric('no_cache_metric', {}, auth(new Set(['financial:read'])), ctx);
      await executeMetric('no_cache_metric', {}, auth(new Set(['financial:read'])), ctx);
      expect(executed).toBe(2);
    });

    it('with a cache field present, a second real call for the same metric+org+params is served from cache, not recomputed', async () => {
      _resetRegistryForTests();
      let executed = 0;
      defineMetric({
        id: 'cached_metric',
        description: 'x',
        parameters: z.object({}),
        unit: 'COUNT',
        requiredPermission: 'financial:read',
        sources: ['t'],
        async execute(): Promise<MetricResult> {
          executed++;
          return {
            metricId: 'cached_metric',
            value: String(executed),
            unit: 'COUNT',
            period: { from: new Date(), to: new Date() },
            computedAt: new Date(),
            freshness: new Date(),
            provenance: [],
          };
        },
      });

      const cachedCtx: MetricContext = { ...ctx, organizationId: `org-registry-${Date.now()}`, cache: redis };
      const first = await executeMetric('cached_metric', {}, auth(new Set(['financial:read'])), cachedCtx);
      const second = await executeMetric('cached_metric', {}, auth(new Set(['financial:read'])), cachedCtx);

      expect(executed).toBe(1);
      expect(first.value).toBe('1');
      expect(second.value).toBe('1'); // NOT '2' — genuinely came from cache, not a second real compute

      await redis.del(`metrics:v1:${cachedCtx.organizationId}:cached_metric:{}`);
    });

    it('permission enforcement still runs BEFORE any cache lookup — a denied caller never even checks the cache', async () => {
      _resetRegistryForTests();
      defineMetric({
        id: 'cached_gated_metric',
        description: 'x',
        parameters: z.object({}),
        unit: 'COUNT',
        requiredPermission: 'financial:read',
        sources: ['t'],
        async execute(): Promise<MetricResult> {
          throw new Error('unreachable — permission check must reject first');
        },
      });

      const cachedCtx: MetricContext = { ...ctx, organizationId: `org-registry-gated-${Date.now()}`, cache: redis };
      await expect(executeMetric('cached_gated_metric', {}, auth(new Set()), cachedCtx)).rejects.toThrow(
        MetricPermissionDeniedError
      );
    });
  });
});
