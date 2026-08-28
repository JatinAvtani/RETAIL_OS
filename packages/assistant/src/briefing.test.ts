import { describe, expect, it } from 'vitest';
import type { MetricResult } from '@retailos/metrics';
import { rankExceptions, toBriefingBundle, MAX_BRIEFING_ITEMS, type BriefingCandidate } from './briefing';

const period = { from: new Date('2026-08-01'), to: new Date('2026-08-31') };
const at = new Date('2026-08-31T12:00:00Z');

const result = (over: Partial<MetricResult> = {}): MetricResult => ({
  metricId: 'some_metric',
  value: '1',
  unit: 'COUNT',
  period,
  computedAt: at,
  freshness: at,
  provenance: [{ table: 't', rowCount: 1 }],
  ...over,
});

const candidate = (
  id: string,
  severity: 'danger' | 'warning',
  res: Partial<MetricResult>,
  scope?: string
): BriefingCandidate => ({
  id,
  severity,
  label: `${id} label`,
  result: result({ metricId: id, ...res }),
  ...(scope !== undefined ? { scope } : {}),
});

const money = (id: string, amount: string, severity: 'danger' | 'warning' = 'warning', scope?: string) =>
  candidate(id, severity, { value: amount, unit: 'CURRENCY' }, scope);

const count = (id: string, n: string, severity: 'danger' | 'warning' = 'warning') =>
  candidate(id, severity, { value: n, unit: 'COUNT' });

describe('rankExceptions — what counts as an exception at all', () => {
  it('drops metrics that computed to zero — a zero is a real "nothing happened", not an exception', () => {
    expect(rankExceptions([count('documents_pending_review', '0')])).toEqual([]);
  });

  it('drops unknown metrics rather than surfacing them as zero-impact items', () => {
    // The failure this guards: treating "we could not compute this" as "there is no problem here"
    // would let a broken pipeline render as a calm day.
    const unknown = candidate('expiry_risk_value', 'warning', { value: 'unknown', unknownReason: 'No lots priced.' });
    expect(rankExceptions([unknown])).toEqual([]);
  });

  it('keeps a real non-zero exception', () => {
    expect(rankExceptions([count('negative_stock_incidents', '3')]).map((r) => r.id)).toEqual([
      'negative_stock_incidents',
    ]);
  });

  it('does not throw on a non-numeric value — it is simply not a rankable exception', () => {
    expect(rankExceptions([candidate('weird', 'warning', { value: 'not-a-number' })])).toEqual([]);
  });
});

describe('rankExceptions — the tiered ranking', () => {
  it('ranks a real monetary exception above a count, regardless of how large the count is', () => {
    // The core honesty property: 900 unmapped items must not outrank a real dollar figure by
    // pretending the count has a dollar value it does not.
    const ranked = rankExceptions([count('unmapped_pos_items_count', '900', 'danger'), money('expiry_risk_value', '12.50')]);
    expect(ranked.map((r) => r.id)).toEqual(['expiry_risk_value', 'unmapped_pos_items_count']);
  });

  it('orders monetary exceptions by their real amount, largest first', () => {
    const ranked = rankExceptions([
      money('expiry_risk_value', '250.00'),
      money('shrinkage_value', '1800.00'),
      money('dead_stock_value', '75.25'),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['shrinkage_value', 'expiry_risk_value', 'dead_stock_value']);
  });

  it('compares money by decimal value, not lexically — "9.00" must outrank "100.00" only if it truly is larger', () => {
    // A string sort would put "9.00" before "100.00". This asserts real numeric comparison.
    const ranked = rankExceptions([money('a', '9.00'), money('b', '100.00')]);
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('orders non-monetary exceptions by severity, danger before warning', () => {
    const ranked = rankExceptions([count('a_warning', '5'), count('z_danger', '1', 'danger')]);
    expect(ranked.map((r) => r.id)).toEqual(['z_danger', 'a_warning']);
  });

  it('breaks exact ties deterministically by id, so ordering never drifts between runs', () => {
    const first = rankExceptions([count('b', '5'), count('a', '5')]).map((r) => r.id);
    const second = rankExceptions([count('a', '5'), count('b', '5')]).map((r) => r.id);
    expect(first).toEqual(['a', 'b']);
    expect(second).toEqual(first);
  });

  it('does not let severity override a real dollar amount within the monetary tier', () => {
    // A `warning` worth far more money still outranks a `danger` worth little — the ranking key for
    // monetary items is the real amount, exactly as "rank by dollar impact" says.
    const ranked = rankExceptions([money('small_danger', '5.00', 'danger'), money('big_warning', '5000.00', 'warning')]);
    expect(ranked.map((r) => r.id)).toEqual(['big_warning', 'small_danger']);
  });
});

describe('rankExceptions — the top 3-6 cap', () => {
  it(`returns at most ${MAX_BRIEFING_ITEMS} items even when far more are real`, () => {
    const many = Array.from({ length: 15 }, (_, i) => money(`m${String(i).padStart(2, '0')}`, `${100 - i}.00`));
    const ranked = rankExceptions(many);
    expect(ranked).toHaveLength(MAX_BRIEFING_ITEMS);
    // And it keeps the LARGEST, not simply the first N encountered.
    expect(ranked[0]!.monetaryImpact).toBe('100.00');
  });

  it('returns fewer than the cap when fewer are genuine — never padded to a target length', () => {
    expect(rankExceptions([count('only_one', '2')])).toHaveLength(1);
  });

  it('returns an empty list for a genuinely calm day', () => {
    expect(rankExceptions([])).toEqual([]);
  });
});

describe('monetaryImpact', () => {
  it('carries the real amount for a currency metric', () => {
    expect(rankExceptions([money('expiry_risk_value', '12.50')])[0]!.monetaryImpact).toBe('12.50');
  });

  it('is null for a count — never a derived or estimated stand-in', () => {
    expect(rankExceptions([count('documents_pending_review', '4')])[0]!.monetaryImpact).toBeNull();
  });
});

describe('toBriefingBundle', () => {
  it('carries the exact executed MetricResults through, so the validator sees the same values the UI cites', () => {
    const ranked = rankExceptions([money('expiry_risk_value', '12.50'), count('documents_pending_review', '4')]);
    const bundle = toBriefingBundle(ranked);
    expect(bundle.metrics).toHaveLength(2);
    expect(bundle.metrics.map((m) => m.metricId)).toEqual(['expiry_risk_value', 'documents_pending_review']);
    expect(bundle.metrics[0]!.value).toBe('12.50');
  });

  it('carries no passages or entities — a briefing narrates metrics only', () => {
    const bundle = toBriefingBundle(rankExceptions([count('a', '1')]));
    expect(bundle.passages).toEqual([]);
    expect(bundle.entities).toEqual([]);
  });

  it('an empty ranking produces an empty bundle, which narration must treat as "nothing to report"', () => {
    expect(toBriefingBundle([])).toEqual({ metrics: [], metricScopes: [], passages: [], entities: [] });
  });

  it('carries each candidate\'s scope through to metricScopes, same length and order as metrics', () => {
    const ranked = rankExceptions([
      money('shrinkage_value', '900.00', 'danger', 'Downtown Store'), // ranks first — largest monetary
      count('stock_projection_drift', '1', 'danger'),
    ]);
    const bundle = toBriefingBundle(ranked);
    expect(bundle.metricScopes).toHaveLength(bundle.metrics.length);
    // shrinkage_value (Downtown Store, real money) outranks stock_projection_drift (no scope, a count).
    expect(bundle.metricScopes).toEqual(['Downtown Store', undefined]);
  });

  it('an explicit org-wide scope label survives through ranking and into the bundle, distinct from an unset scope', () => {
    const orgWide = candidate('stock_projection_drift', 'danger', { value: '1', unit: 'COUNT' }, 'entire organization (all stores)');
    const bundle = toBriefingBundle(rankExceptions([orgWide]));
    expect(bundle.metricScopes).toEqual(['entire organization (all stores)']);
  });
});
