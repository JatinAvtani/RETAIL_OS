import { describe, expect, it } from 'vitest';
import type { GroundingBundle } from './grounding-bundle';

/**
 * a real structural proof that `GroundingBundle.metrics` accepts an actual
 * `MetricResult` value (not just that the types compile) — a bundle with a genuinely computed
 * metric result is exactly what earlier work (grounding bundle assembly, not built yet) will construct.
 */
describe('GroundingBundle', () => {
  it('accepts a real MetricResult inside metrics[]', () => {
    const bundle: GroundingBundle = {
      metrics: [
        {
          metricId: 'food_cost_percentage',
          value: '28.4',
          unit: 'PERCENTAGE',
          period: { from: new Date('2026-08-01'), to: new Date('2026-08-31') },
          computedAt: new Date('2026-08-31T23:59:00Z'),
          freshness: new Date('2026-08-31T23:59:00Z'),
          provenance: [{ table: 'fact_daily_consumption', rowCount: 31 }],
        },
      ],
      passages: [],
      entities: [],
    };

    expect(bundle.metrics[0]?.metricId).toBe('food_cost_percentage');
    expect(bundle.metrics[0]?.value).toBe('28.4');
  });

  it('accepts an unknown-valued MetricResult (I7) without special-casing', () => {
    const bundle: GroundingBundle = {
      metrics: [
        {
          metricId: 'margin_per_item',
          value: 'unknown',
          unit: 'CURRENCY',
          period: { from: new Date('2026-08-01'), to: new Date('2026-08-31') },
          computedAt: new Date(),
          freshness: new Date(),
          provenance: [],
          unknownReason: 'No recipe exists for this menu item.',
        },
      ],
      passages: [],
      entities: [],
    };

    expect(bundle.metrics[0]?.value).toBe('unknown');
    expect(bundle.metrics[0]?.unknownReason).toBe('No recipe exists for this menu item.');
  });
});
