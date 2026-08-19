import { describe, expect, it } from 'vitest';
import { buildRefusal } from './refusal';
import type { GroundingBundle } from './grounding-bundle';

const period = { from: new Date('2026-08-01'), to: new Date('2026-08-31') };

const knownMetric: GroundingBundle['metrics'][number] = {
  metricId: 'net_revenue',
  value: '1234.5600',
  unit: 'CURRENCY',
  period,
  computedAt: new Date('2026-08-31T23:59:00Z'),
  freshness: new Date('2026-08-31T23:59:00Z'),
  provenance: [{ table: 'sales_transaction_lines', rowCount: 12 }],
};

const unknownMetric = (unknownReason: string): GroundingBundle['metrics'][number] => ({
  metricId: 'margin_per_item',
  value: 'unknown',
  unit: 'CURRENCY',
  period,
  computedAt: new Date(),
  freshness: new Date(),
  provenance: [],
  unknownReason,
});

describe('buildRefusal', () => {
  it('returns null when every requested metric has a real value and there are no gaps', () => {
    const bundle: GroundingBundle = { metrics: [knownMetric], passages: [], entities: [] };
    expect(buildRefusal(bundle, [], [], [])).toBeNull();
  });

  it('returns null for a genuinely empty bundle with no gaps either — nothing was requested at all', () => {
    const bundle: GroundingBundle = { metrics: [], passages: [], entities: [] };
    expect(buildRefusal(bundle, [], [], [])).toBeNull();
  });

  it('a fully-unknown bundle is fullyUnanswerable, with the real unknownReason and a matching remedy — the spec\'s own "no recipe" example', () => {
    const bundle: GroundingBundle = { metrics: [unknownMetric('The linked recipe has no fully-resolvable unit cost.')], passages: [], entities: [] };

    const refusal = buildRefusal(bundle, [], [], []);

    expect(refusal).not.toBeNull();
    expect(refusal!.fullyUnanswerable).toBe(true);
    expect(refusal!.items).toHaveLength(1);
    expect(refusal!.items[0]).toMatchObject({
      metricId: 'margin_per_item',
      category: 'unknown_metric_value',
      reason: 'The linked recipe has no fully-resolvable unit cost.',
    });
    expect(refusal!.items[0]!.remedy.toLowerCase()).toContain('recipe');
  });

  it('a mix of one real value and one unknown value is NOT fully unanswerable — a partial answer exists', () => {
    const bundle: GroundingBundle = { metrics: [knownMetric, unknownMetric('No currently-effective price exists for this supplier-product mapping.')], passages: [], entities: [] };

    const refusal = buildRefusal(bundle, [], [], []);

    expect(refusal).not.toBeNull();
    expect(refusal!.fullyUnanswerable).toBe(false);
    expect(refusal!.items).toHaveLength(1);
    expect(refusal!.items[0]!.remedy.toLowerCase()).toContain('cost');
  });

  it('a denied selection produces a permission_denied item with a real, distinct remedy', () => {
    const bundle: GroundingBundle = { metrics: [], passages: [], entities: [] };

    const refusal = buildRefusal(bundle, [{ metricId: 'cogs_actual', reason: "Caller lacks 'financial:read'." }], [], []);

    expect(refusal).not.toBeNull();
    expect(refusal!.fullyUnanswerable).toBe(true);
    expect(refusal!.items[0]).toMatchObject({ metricId: 'cogs_actual', category: 'permission_denied', reason: "Caller lacks 'financial:read'." });
    expect(refusal!.items[0]!.remedy.toLowerCase()).toContain('permission');
  });

  it('a failed selection produces an execution_failed item with the generic remedy — no specific fix is knowable for an internal error', () => {
    const bundle: GroundingBundle = { metrics: [], passages: [], entities: [] };

    const refusal = buildRefusal(bundle, [], [{ metricId: 'total_spend', reason: 'Unexpected database error.' }], []);

    expect(refusal).not.toBeNull();
    expect(refusal!.items[0]).toMatchObject({ metricId: 'total_spend', category: 'execution_failed' });
    expect(refusal!.items[0]!.remedy).toContain('rephrasing');
  });

  it('a rejected planning selection produces an invalid_selection item', () => {
    const bundle: GroundingBundle = { metrics: [], passages: [], entities: [] };

    const refusal = buildRefusal(bundle, [], [], [{ metricId: 'invented_metric', reason: "'invented_metric' is not a registered metric." }]);

    expect(refusal).not.toBeNull();
    expect(refusal!.items[0]).toMatchObject({ metricId: 'invented_metric', category: 'invalid_selection' });
    expect(refusal!.items[0]!.remedy.toLowerCase()).toContain('rephras');
  });

  it('an unrecognized unknownReason gets the honest generic remedy, never a fabricated specific one', () => {
    const bundle: GroundingBundle = { metrics: [unknownMetric('Some entirely novel reason this test invented.')], passages: [], entities: [] };

    const refusal = buildRefusal(bundle, [], [], []);

    expect(refusal!.items[0]!.remedy).toBe('No specific fix is known for this — try rephrasing the question or asking about a narrower date range.');
  });

  it('a missing unknownReason (should not happen, but not assumed impossible) still produces an honest item, never a crash', () => {
    const metricWithNoReason: GroundingBundle['metrics'][number] = {
      metricId: 'margin_per_item',
      value: 'unknown',
      unit: 'CURRENCY',
      period,
      computedAt: new Date(),
      freshness: new Date(),
      provenance: [],
    };
    const bundle: GroundingBundle = { metrics: [metricWithNoReason], passages: [], entities: [] };

    const refusal = buildRefusal(bundle, [], [], []);

    expect(refusal!.items[0]!.reason).toBe('This could not be computed for an unspecified reason.');
  });

  it('multiple gap sources at once each produce their own item, all surfaced — nothing silently dropped', () => {
    const bundle: GroundingBundle = { metrics: [unknownMetric('No recipe exists for this menu item.')], passages: [], entities: [] };

    const refusal = buildRefusal(
      bundle,
      [{ metricId: 'cogs_actual', reason: "Caller lacks 'financial:read'." }],
      [{ metricId: 'total_spend', reason: 'Unexpected database error.' }],
      [{ metricId: 'invented_metric', reason: "'invented_metric' is not a registered metric." }]
    );

    expect(refusal!.items).toHaveLength(4);
    expect(refusal!.fullyUnanswerable).toBe(true);
    const categories = refusal!.items.map((i) => i.category).sort();
    expect(categories).toEqual(['execution_failed', 'invalid_selection', 'permission_denied', 'unknown_metric_value']);
  });

  describe('remedy pattern matching against real catalog unknownReason strings', () => {
    it('recognizes a "not found" reason', () => {
      const refusal = buildRefusal({ metrics: [unknownMetric("Menu item 'flat-white' not found.")], passages: [], entities: [] }, [], [], []);
      expect(refusal!.items[0]!.remedy.toLowerCase()).toContain('check the name');
    });

    it('recognizes a "no sales/no transactions" reason', () => {
      const refusal = buildRefusal({ metrics: [unknownMetric('No completed transactions in the period.')], passages: [], entities: [] }, [], [], []);
      expect(refusal!.items[0]!.remedy.toLowerCase()).toContain('date range');
    });

    it('recognizes a "no purchase orders" reason', () => {
      const refusal = buildRefusal({ metrics: [unknownMetric('No purchase orders were sent in this period.')], passages: [], entities: [] }, [], [], []);
      expect(refusal!.items[0]!.remedy.toLowerCase()).toContain('purchasing activity');
    });
  });
});
