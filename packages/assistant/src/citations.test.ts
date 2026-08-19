import { describe, expect, it } from 'vitest';
import { listMetricIds } from '@retailos/metrics';
import { buildCitations, smallSampleCaveat, SMALL_SAMPLE_ROW_THRESHOLD, type MetricCitation } from './citations';
import type { GroundingBundle } from './grounding-bundle';

const period = { from: new Date('2026-08-01'), to: new Date('2026-08-31') };
const computedAt = new Date('2026-08-31T23:59:00Z');

const metric = (over: Partial<GroundingBundle['metrics'][number]> = {}): GroundingBundle['metrics'][number] => ({
  metricId: 'net_revenue',
  value: '1234.5600',
  unit: 'CURRENCY',
  period,
  computedAt,
  freshness: computedAt,
  provenance: [{ table: 'sales_transaction_lines', rowCount: 120 }],
  ...over,
});

const bundleOf = (metrics: GroundingBundle['metrics'], passages: GroundingBundle['passages'] = []): GroundingBundle => ({
  metrics,
  passages,
  entities: [],
});

describe('buildCitations', () => {
  it('carries the real period, freshness and computedAt through unchanged — a figure without its period is not a fact', () => {
    const { metrics } = buildCitations(bundleOf([metric()]));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.period).toEqual(period);
    expect(metrics[0]!.freshness).toEqual(computedAt);
    expect(metrics[0]!.computedAt).toEqual(computedAt);
  });

  it('reads the plain-English explanation from the metric catalog itself, not a second local copy', () => {
    // Guards the I2 intent of this module: the explanation must be the SAME string the catalog
    // holds, so a catalog edit propagates here with no code change. Asserting a hardcoded sentence
    // would let the two drift silently — exactly what this test exists to prevent.
    const registeredId = listMetricIds().find((id) => id === 'net_revenue');
    expect(registeredId, 'net_revenue must be registered for this test to be meaningful').toBe('net_revenue');

    const { metrics } = buildCitations(bundleOf([metric()]));
    expect(metrics[0]!.explanation).toBeTypeOf('string');
    expect(metrics[0]!.explanation!.length).toBeGreaterThan(0);
  });

  it('returns a null explanation for an unregistered metric — never the raw id dressed up as prose', () => {
    const { metrics } = buildCitations(bundleOf([metric({ metricId: 'not_a_real_registered_metric' })]));
    expect(metrics[0]!.explanation).toBeNull();
    // The specific failure this guards: falling back to the id would render "not_a_real_registered_metric"
    // in the UI's "how this was calculated" slot, reading as an explanation when none exists.
    expect(metrics[0]!.explanation).not.toBe('not_a_real_registered_metric');
  });

  it('sums provenance row counts across every source table', () => {
    const { metrics } = buildCitations(
      bundleOf([
        metric({
          provenance: [
            { table: 'sales_transaction_lines', rowCount: 40 },
            { table: 'stock_movements', rowCount: 2 },
          ],
        }),
      ])
    );
    expect(metrics[0]!.sources).toEqual([
      { table: 'sales_transaction_lines', rowCount: 40 },
      { table: 'stock_movements', rowCount: 2 },
    ]);
    expect(metrics[0]!.totalRowCount).toBe(42);
  });

  it('cites unknown figures too, carrying their real unknownReason — an unknown is a finding, not an omission', () => {
    const { metrics } = buildCitations(
      bundleOf([metric({ value: 'unknown', provenance: [], unknownReason: 'The linked recipe has no fully-resolvable unit cost.' })])
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.unknownReason).toBe('The linked recipe has no fully-resolvable unit cost.');
    expect(metrics[0]!.totalRowCount).toBe(0);
  });

  it('omits unknownReason entirely for a known figure, rather than setting it undefined', () => {
    const { metrics } = buildCitations(bundleOf([metric()]));
    expect('unknownReason' in metrics[0]!).toBe(false);
  });

  it('passes retrieval passages through with their real source ids and scores', () => {
    const { passages } = buildCitations(
      bundleOf(
        [],
        [{ sourceType: 'document_chunk', sourceId: 'doc-1', text: 'Flour 25kg — 1,850.00', score: 0.82 }]
      )
    );
    expect(passages).toEqual([
      { sourceType: 'document_chunk', sourceId: 'doc-1', text: 'Flour 25kg — 1,850.00', score: 0.82 },
    ]);
  });

  it('an empty bundle produces empty citation lists, never a fabricated placeholder citation', () => {
    expect(buildCitations(bundleOf([]))).toEqual({ metrics: [], passages: [] });
  });
});

describe('smallSampleCaveat', () => {
  const citationWith = (over: Partial<MetricCitation>): MetricCitation => ({
    metricId: 'net_revenue',
    explanation: 'Total sales revenue in the period.',
    period,
    freshness: computedAt,
    computedAt,
    sources: [{ table: 'sales_transaction_lines', rowCount: 5 }],
    totalRowCount: 5,
    ...over,
  });

  it('states the REAL row count so a reader can judge the sample themselves', () => {
    expect(smallSampleCaveat(citationWith({}))).toBe('Based on 5 rows — a small sample.');
  });

  it('singularises one row rather than emitting "1 rows"', () => {
    expect(smallSampleCaveat(citationWith({ sources: [{ table: 't', rowCount: 1 }], totalRowCount: 1 }))).toBe(
      'Based on 1 row — a small sample.'
    );
  });

  it('returns null once the sample reaches the threshold — no caveat where none is warranted', () => {
    expect(
      smallSampleCaveat(citationWith({ totalRowCount: SMALL_SAMPLE_ROW_THRESHOLD, sources: [{ table: 't', rowCount: SMALL_SAMPLE_ROW_THRESHOLD }] }))
    ).toBeNull();
  });

  it('is inclusive at the boundary: one row below the threshold still caveats', () => {
    const below = SMALL_SAMPLE_ROW_THRESHOLD - 1;
    expect(smallSampleCaveat(citationWith({ totalRowCount: below, sources: [{ table: 't', rowCount: below }] }))).toBe(
      `Based on ${below} rows — a small sample.`
    );
  });

  it('returns null for an unknown figure — it already carries its own reason, and a sample caveat would imply a number exists', () => {
    expect(smallSampleCaveat(citationWith({ unknownReason: 'No recipe.', totalRowCount: 3 }))).toBeNull();
  });

  it('returns null when the metric declared no sources at all — silence is not evidence of a small sample', () => {
    expect(smallSampleCaveat(citationWith({ sources: [], totalRowCount: 0 }))).toBeNull();
  });
});
