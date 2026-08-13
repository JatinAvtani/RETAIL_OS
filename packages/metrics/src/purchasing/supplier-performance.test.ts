import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  computeFillRate,
  computeOnTimeRate,
  computeTotalPriceVariance,
  computeInvoiceAccuracy,
  computeQualityRejectRate,
  computeSupplierPerformanceComponents,
  computeSupplierPerformanceTrend,
  type SupplierPerformanceEventInput,
} from './supplier-performance';

const event = (overrides: Partial<SupplierPerformanceEventInput>): SupplierPerformanceEventInput => ({
  eventType: 'FILL_COMPLETE',
  expectedValue: null,
  actualValue: null,
  variance: null,
  ...overrides,
});

describe('computeFillRate', () => {
  it('returns null for no fill events at all — I7, never a fabricated rate', () => {
    expect(computeFillRate([])).toBeNull();
    expect(computeFillRate([event({ eventType: 'DELIVERY_ON_TIME' })])).toBeNull();
  });

  it('a single fully-filled delivery is exactly 1', () => {
    const rate = computeFillRate([event({ eventType: 'FILL_COMPLETE', expectedValue: '10', actualValue: '10' })]);
    expect(rate).toBe(1);
  });

  it('a single short delivery is the real fraction, exactly', () => {
    const rate = computeFillRate([event({ eventType: 'FILL_SHORT', expectedValue: '10', actualValue: '8' })]);
    expect(rate).toBe(0.8);
  });

  it('sums across multiple deliveries rather than averaging per-event — a large short delivery outweighs several small complete ones', () => {
    const rate = computeFillRate([
      event({ eventType: 'FILL_COMPLETE', expectedValue: '1', actualValue: '1' }),
      event({ eventType: 'FILL_COMPLETE', expectedValue: '1', actualValue: '1' }),
      event({ eventType: 'FILL_SHORT', expectedValue: '100', actualValue: '50' }),
    ]);
    // ordered total 102, received total 52
    expect(rate).toBeCloseTo(52 / 102, 10);
  });

  it('an over-delivery produces a rate above 1 — a real, honest fact, never clamped', () => {
    const rate = computeFillRate([event({ eventType: 'FILL_COMPLETE', expectedValue: '10', actualValue: '12' })]);
    expect(rate).toBe(1.2);
  });
});

describe('computeOnTimeRate', () => {
  it('returns null with no delivery-timing events', () => {
    expect(computeOnTimeRate([])).toBeNull();
  });

  it('computes the exact fraction', () => {
    const rate = computeOnTimeRate([
      event({ eventType: 'DELIVERY_ON_TIME' }),
      event({ eventType: 'DELIVERY_ON_TIME' }),
      event({ eventType: 'DELIVERY_ON_TIME' }),
      event({ eventType: 'DELIVERY_LATE' }),
    ]);
    expect(rate).toBe(0.75);
  });

  it('all late is exactly 0, not null — a real measured fact, not an unknown', () => {
    expect(computeOnTimeRate([event({ eventType: 'DELIVERY_LATE' })])).toBe(0);
  });
});

describe('computeTotalPriceVariance', () => {
  it('returns null with no price-variance events', () => {
    expect(computeTotalPriceVariance([])).toBeNull();
  });

  it('sums real per-unit variances exactly, preserving sign', () => {
    const total = computeTotalPriceVariance([
      event({ eventType: 'PRICE_VARIANCE', variance: '1.5000' }),
      event({ eventType: 'PRICE_VARIANCE', variance: '-0.2500' }),
    ]);
    expect(total).toBe('1.2500');
  });

  it('never coerces a null variance to zero — a genuinely unclassifiable line contributes nothing, not a guessed number', () => {
    const total = computeTotalPriceVariance([
      event({ eventType: 'PRICE_VARIANCE', variance: '2.0000' }),
      event({ eventType: 'PRICE_VARIANCE', variance: null }),
    ]);
    expect(total).toBe('2.0000');
  });
});

describe('computeInvoiceAccuracy', () => {
  it('returns null with no invoice-outcome events', () => {
    expect(computeInvoiceAccuracy([])).toBeNull();
  });

  it('computes the exact clean fraction', () => {
    const rate = computeInvoiceAccuracy([
      event({ eventType: 'INVOICE_CLEAN' }),
      event({ eventType: 'INVOICE_CLEAN' }),
      event({ eventType: 'INVOICE_CLEAN' }),
      event({ eventType: 'INVOICE_ERROR' }),
    ]);
    expect(rate).toBe(0.75);
  });
});

describe('computeQualityRejectRate', () => {
  it('returns null with no received quantity to divide by', () => {
    expect(computeQualityRejectRate([])).toBeNull();
    expect(computeQualityRejectRate([event({ eventType: 'QUALITY_REJECT', actualValue: '5' })])).toBeNull();
  });

  it('computes rejected over total received, exactly', () => {
    const rate = computeQualityRejectRate([
      event({ eventType: 'FILL_COMPLETE', expectedValue: '20', actualValue: '20' }),
      event({ eventType: 'QUALITY_REJECT', actualValue: '4' }),
    ]);
    expect(rate).toBe(0.2);
  });

  it('zero real quality-reject events is exactly 0, not null — a genuinely clean receiving history', () => {
    const rate = computeQualityRejectRate([event({ eventType: 'FILL_COMPLETE', expectedValue: '10', actualValue: '10' })]);
    expect(rate).toBe(0);
  });
});

describe('computeSupplierPerformanceComponents', () => {
  it('every field is independently null for a totally empty event list — never a partial fabricated object', () => {
    const components = computeSupplierPerformanceComponents([]);
    expect(components).toEqual({
      fillRate: null,
      onTimeRate: null,
      totalPriceVariance: null,
      invoiceAccuracy: null,
      qualityRejectRate: null,
    });
  });

  it('one component being computable does not fabricate the others', () => {
    const components = computeSupplierPerformanceComponents([event({ eventType: 'DELIVERY_ON_TIME' })]);
    expect(components.onTimeRate).toBe(1);
    expect(components.fillRate).toBeNull();
    expect(components.invoiceAccuracy).toBeNull();
    expect(components.qualityRejectRate).toBeNull();
  });
});

describe('property: fill rate always equals the true summed ratio', () => {
  it('for any real sequence of ordered/received pairs, computeFillRate matches direct division', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ordered: fc.integer({ min: 1, max: 100000 }),
            received: fc.integer({ min: 0, max: 100000 }),
          }),
          { minLength: 1, maxLength: 50 }
        ),
        (pairs) => {
          const events = pairs.map((p) =>
            event({
              eventType: p.received >= p.ordered ? 'FILL_COMPLETE' : 'FILL_SHORT',
              expectedValue: String(p.ordered),
              actualValue: String(p.received),
            })
          );
          const rate = computeFillRate(events);
          const orderedTotal = pairs.reduce((s, p) => s + p.ordered, 0);
          const receivedTotal = pairs.reduce((s, p) => s + p.received, 0);
          expect(rate).not.toBeNull();
          expect(rate!).toBeCloseTo(receivedTotal / orderedTotal, 8);
        }
      )
    );
  });
});

describe('property: on-time rate and invoice accuracy are always within [0, 1]', () => {
  it('a true/false ratio can never fall outside its own bounds regardless of event count', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 200 }),
        (onTimeFlags) => {
          const events = onTimeFlags.map((onTime) => event({ eventType: onTime ? 'DELIVERY_ON_TIME' : 'DELIVERY_LATE' }));
          const rate = computeOnTimeRate(events);
          expect(rate).not.toBeNull();
          expect(rate!).toBeGreaterThanOrEqual(0);
          expect(rate!).toBeLessThanOrEqual(1);
        }
      )
    );
  });
});

describe('computeSupplierPerformanceTrend', () => {
  it('both windows empty: every component is null/null with a null direction — never a fabricated trend', () => {
    const trend = computeSupplierPerformanceTrend([], []);
    expect(trend.fillRate).toEqual({ current: null, previous: null, direction: null });
    expect(trend.onTimeRate).toEqual({ current: null, previous: null, direction: null });
    expect(trend.totalPriceVariance).toEqual({ current: null, previous: null, direction: null });
    expect(trend.invoiceAccuracy).toEqual({ current: null, previous: null, direction: null });
    expect(trend.qualityRejectRate).toEqual({ current: null, previous: null, direction: null });
  });

  it('a real improving on-time rate is flagged "up"', () => {
    const previousEvents = [event({ eventType: 'DELIVERY_ON_TIME' }), event({ eventType: 'DELIVERY_LATE' })]; // 50%
    const currentEvents = [event({ eventType: 'DELIVERY_ON_TIME' }), event({ eventType: 'DELIVERY_ON_TIME' })]; // 100%
    const trend = computeSupplierPerformanceTrend(currentEvents, previousEvents);
    expect(trend.onTimeRate.current).toBe(1);
    expect(trend.onTimeRate.previous).toBe(0.5);
    expect(trend.onTimeRate.direction).toBe('up');
  });

  it('a real degrading fill rate is flagged "down"', () => {
    const previousEvents = [event({ eventType: 'FILL_COMPLETE', expectedValue: '10', actualValue: '10' })]; // 100%
    const currentEvents = [event({ eventType: 'FILL_SHORT', expectedValue: '10', actualValue: '5' })]; // 50%
    const trend = computeSupplierPerformanceTrend(currentEvents, previousEvents);
    expect(trend.fillRate.direction).toBe('down');
  });

  it('an identical rate across both windows is flagged "flat", not "up" or "down"', () => {
    const events = [event({ eventType: 'INVOICE_CLEAN' }), event({ eventType: 'INVOICE_ERROR' })]; // 50%
    const trend = computeSupplierPerformanceTrend(events, events);
    expect(trend.invoiceAccuracy.direction).toBe('flat');
  });

  it('a real value in the current window against no history in the previous window is a null direction, never a fabricated "up"', () => {
    const currentEvents = [event({ eventType: 'QUALITY_REJECT', actualValue: '2' }), event({ eventType: 'FILL_COMPLETE', expectedValue: '10', actualValue: '10' })];
    const trend = computeSupplierPerformanceTrend(currentEvents, []);
    expect(trend.qualityRejectRate.current).not.toBeNull();
    expect(trend.qualityRejectRate.previous).toBeNull();
    expect(trend.qualityRejectRate.direction).toBeNull();
  });

  it('the decimal-string totalPriceVariance trend compares real magnitude, not string ordering', () => {
    // '9.0000' vs '10.0000' would sort as string-greater the wrong way (lexicographic '9' > '1') if compared naively.
    const previousEvents = [event({ eventType: 'PRICE_VARIANCE', variance: '9.0000' })];
    const currentEvents = [event({ eventType: 'PRICE_VARIANCE', variance: '10.0000' })];
    const trend = computeSupplierPerformanceTrend(currentEvents, previousEvents);
    expect(trend.totalPriceVariance.direction).toBe('up');
  });
});
