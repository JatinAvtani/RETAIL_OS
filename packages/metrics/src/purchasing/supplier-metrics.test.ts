import { describe, expect, it } from 'vitest';
import { computeLeadTimeActual, computeLeadTimeVariance, computePriceStabilityIndex } from './supplier-metrics';

describe('computeLeadTimeActual', () => {
  it('averages real days from sentAt to receivedAt', () => {
    const result = computeLeadTimeActual([
      { sentAt: new Date('2026-01-01T00:00:00Z'), receivedAt: new Date('2026-01-03T00:00:00Z') },
      { sentAt: new Date('2026-01-05T00:00:00Z'), receivedAt: new Date('2026-01-06T00:00:00Z') },
    ]);
    // (2 + 1) / 2 = 1.5 days.
    expect(result).toBe(1.5);
  });

  it('is unknown with zero receipts in the period, never a fabricated 0-day average', () => {
    expect(computeLeadTimeActual([])).toBe('unknown');
  });
});

describe('computeLeadTimeVariance', () => {
  it('computes the population standard deviation of real lead times', () => {
    // Lead times: 2, 4, 4, 4, 5, 5, 7, 9 days -> mean 5, population stdev 2.
    const dates = [2, 4, 4, 4, 5, 5, 7, 9];
    const lines = dates.map((days) => ({
      sentAt: new Date('2026-01-01T00:00:00Z'),
      receivedAt: new Date(new Date('2026-01-01T00:00:00Z').getTime() + days * 24 * 60 * 60 * 1000),
    }));
    const result = computeLeadTimeVariance(lines);
    expect(result).toBe(2);
  });

  it('is unknown with fewer than 2 data points, never a fabricated 0 stdev', () => {
    expect(computeLeadTimeVariance([])).toBe('unknown');
    expect(
      computeLeadTimeVariance([{ sentAt: new Date('2026-01-01T00:00:00Z'), receivedAt: new Date('2026-01-02T00:00:00Z') }])
    ).toBe('unknown');
  });
});

describe('computePriceStabilityIndex', () => {
  it('computes the coefficient of variation of real price history points', () => {
    // Prices: 8, 9, 10, 11, 12 -> mean 10, population stdev ~1.4142, CV ~0.1414.
    const result = computePriceStabilityIndex([
      { unitPrice: '8' },
      { unitPrice: '9' },
      { unitPrice: '10' },
      { unitPrice: '11' },
      { unitPrice: '12' },
    ]);
    expect(result).not.toBe('unknown');
    expect(result as number).toBeCloseTo(0.1414, 3);
  });

  it('a perfectly stable price series has a CV of exactly 0', () => {
    const result = computePriceStabilityIndex([{ unitPrice: '5.00' }, { unitPrice: '5.00' }, { unitPrice: '5.00' }]);
    expect(result).toBe(0);
  });

  it('is unknown with fewer than 2 price points, never a fabricated 0', () => {
    expect(computePriceStabilityIndex([])).toBe('unknown');
    expect(computePriceStabilityIndex([{ unitPrice: '5.00' }])).toBe('unknown');
  });

  it('is unknown when the mean price is zero, never a fabricated infinite/zero index', () => {
    expect(computePriceStabilityIndex([{ unitPrice: '0' }, { unitPrice: '0' }])).toBe('unknown');
  });
});
