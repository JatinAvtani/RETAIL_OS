import { describe, expect, it } from 'vitest';
import { applyDefaultStore, resolveStoreParams, type AccessibleStore } from './resolve-store-params';
import type { ValidatedSelection } from './planning';

/**
 * These tests pin the I7 gap that made this module necessary: a `storeId` the model invented is
 * syntactically a valid UUID, so it passed every check that existed before — the metric's own
 * `z.string().uuid()` schema, and `executeMetric`'s permission gate — then matched zero rows under
 * the org-scoped repositories and was reported by a summing metric as `"0.0000"`.
 *
 * A confident zero is indistinguishable from a store that genuinely sold nothing, and the grounding
 * validator cannot catch it because a metric value is exactly what its allowlist permits. The only
 * place it can be caught is here, before execution.
 */

const KORAMANGALA = '11111111-1111-4111-8111-111111111111';
const INDIRANAGAR = '22222222-2222-4222-8222-222222222222';
const INVENTED = '99999999-9999-4999-8999-999999999999';

const stores: AccessibleStore[] = [
  { id: KORAMANGALA, name: 'Koramangala' },
  { id: INDIRANAGAR, name: 'Indiranagar' },
];

const selection = (params: Record<string, unknown>): ValidatedSelection => ({ metricId: 'net_revenue', params });

describe('resolveStoreParams', () => {
  it('rejects an invented storeId rather than executing it — the exact path that produced a fabricated zero', () => {
    const result = resolveStoreParams([selection({ storeId: INVENTED })], stores);

    expect(result.resolved).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.metricId).toBe('net_revenue');
    expect(result.rejected[0]?.reason).toContain('not a store this account can access');
  });

  it('names the real stores in the rejection so the caller can ask again with one', () => {
    const result = resolveStoreParams([selection({ storeId: INVENTED })], stores);

    expect(result.rejected[0]?.reason).toContain('Koramangala');
    expect(result.rejected[0]?.reason).toContain('Indiranagar');
  });

  it('passes through a storeId the caller genuinely has', () => {
    const result = resolveStoreParams([selection({ storeId: KORAMANGALA })], stores);

    expect(result.rejected).toEqual([]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]?.params.storeId).toBe(KORAMANGALA);
  });

  it('passes through an org-scoped metric that takes no storeId at all', () => {
    const result = resolveStoreParams([selection({ from: new Date('2026-08-01') })], stores);

    expect(result.rejected).toEqual([]);
    expect(result.resolved).toHaveLength(1);
  });

  it('rejects per-selection, never all-or-nothing — one bad store does not discard a good one', () => {
    const result = resolveStoreParams(
      [selection({ storeId: KORAMANGALA }), selection({ storeId: INVENTED })],
      stores
    );

    expect(result.resolved).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });

  it('reports a real-but-inaccessible store identically to an invented one — never leaks that another tenant s store exists', () => {
    const invented = resolveStoreParams([selection({ storeId: INVENTED })], stores);
    const otherTenant = resolveStoreParams([selection({ storeId: '33333333-3333-4333-8333-333333333333' })], stores);

    expect(otherTenant.rejected[0]?.reason).toBe(invented.rejected[0]?.reason.replace(INVENTED, '33333333-3333-4333-8333-333333333333'));
  });

  it('rejects every store-scoped selection when the caller has no stores at all', () => {
    const result = resolveStoreParams([selection({ storeId: KORAMANGALA })], []);

    expect(result.resolved).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('No store is available to this account');
  });

  it('rejects a non-string storeId rather than coercing it', () => {
    const result = resolveStoreParams([selection({ storeId: 42 })], stores);

    expect(result.resolved).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('was not a string');
  });
});

describe('applyDefaultStore', () => {
  it('fills an omitted storeId when there is exactly one accessible store — no ambiguity to resolve', () => {
    const result = applyDefaultStore({ from: '2026-08-01' }, [stores[0]!]);

    expect(result.storeId).toBe(KORAMANGALA);
  });

  it('does NOT guess when several stores are accessible — the caller gets asked instead', () => {
    const result = applyDefaultStore({ from: '2026-08-01' }, stores);

    expect(result.storeId).toBeUndefined();
  });

  it('never overwrites a storeId the model correctly chose', () => {
    const result = applyDefaultStore({ storeId: INDIRANAGAR }, [stores[0]!]);

    expect(result.storeId).toBe(INDIRANAGAR);
  });

  it('does nothing when the caller has no stores', () => {
    const result = applyDefaultStore({ from: '2026-08-01' }, []);

    expect(result.storeId).toBeUndefined();
  });
});
