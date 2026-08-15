import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
});
