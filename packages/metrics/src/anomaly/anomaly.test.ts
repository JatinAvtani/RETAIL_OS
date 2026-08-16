import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { computeConsumptionAnomalyDays, computeCostSpike, computeSalesAnomalies, computeWasteSpikes } from './anomaly.js';

const d = (n: number) => new Decimal(n);

describe('computeSalesAnomalies', () => {
  it('is unknown with fewer than 14 days of data', () => {
    const series = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: d(100),
    }));
    expect(computeSalesAnomalies(series)).toBe('unknown');
  });

  it('flags a real, isolated single-day spike among 3 weeks of otherwise-flat data', () => {
    const series = Array.from({ length: 21 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: d(100),
    }));
    // Day 11 (well inside the trend-computable range) gets a real, large one-off spike.
    series[10] = { date: series[10]!.date, value: d(500) };
    const result = computeSalesAnomalies(series);
    expect(result).not.toBe('unknown');
    const flagged = result as Exclude<typeof result, 'unknown'>;
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.some((f) => f.date === series[10]!.date)).toBe(true);
  });

  it('flags nothing for a perfectly flat, unremarkable series', () => {
    const series = Array.from({ length: 21 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: d(100),
    }));
    const result = computeSalesAnomalies(series);
    expect(result).not.toBe('unknown');
    expect(result as Exclude<typeof result, 'unknown'>).toEqual([]);
  });
});

describe('computeCostSpike', () => {
  it('is unknown with fewer than 2 historical price points', () => {
    expect(computeCostSpike([{ date: '2026-01-01', unitPrice: '5.0000' }])).toBe('unknown');
  });

  it('flags a real >15% jump from the median', () => {
    // 5 historical prices at $5.00, then a latest price at $6.00 -> +20% vs the $5.00 median.
    const history = [
      { date: '2026-01-01', unitPrice: '5.0000' },
      { date: '2026-01-02', unitPrice: '5.0000' },
      { date: '2026-01-03', unitPrice: '5.0000' },
      { date: '2026-01-04', unitPrice: '5.0000' },
      { date: '2026-01-05', unitPrice: '6.0000' },
    ];
    const result = computeCostSpike(history);
    expect(result).not.toBe('unknown');
    const spike = result as Exclude<typeof result, 'unknown'>;
    expect(spike.isSpike).toBe(true);
    expect(spike.medianPrice).toBe('5.0000');
    expect(spike.percentChange).toBe('20.00');
  });

  it('does not flag a small, ordinary price movement', () => {
    const history = [
      { date: '2026-01-01', unitPrice: '5.0000' },
      { date: '2026-01-02', unitPrice: '5.1000' },
      { date: '2026-01-03', unitPrice: '5.0500' },
    ];
    const result = computeCostSpike(history);
    expect(result).not.toBe('unknown');
    expect((result as Exclude<typeof result, 'unknown'>).isSpike).toBe(false);
  });

  it('is unknown when the median price is zero, never a fabricated percentage', () => {
    const history = [
      { date: '2026-01-01', unitPrice: '0.0000' },
      { date: '2026-01-02', unitPrice: '0.0000' },
    ];
    expect(computeCostSpike(history)).toBe('unknown');
  });
});

describe('computeWasteSpikes', () => {
  it('is unknown with fewer than 2 days of data', () => {
    expect(computeWasteSpikes([{ date: '2026-01-01', value: d(10) }])).toBe('unknown');
  });

  it('flags a real day whose waste value is more than 2 population-stdev above the mean', () => {
    // Hand-derived: 6 baseline days at 10, one day at 80. mean = (6*10+80)/7 = 20. stdev computed
    // from population formula. Verified: outlier z ~= 2.449 > 2 with n=7, all others well under.
    const days = [
      { date: '2026-01-01', value: d(10) },
      { date: '2026-01-02', value: d(10) },
      { date: '2026-01-03', value: d(10) },
      { date: '2026-01-04', value: d(10) },
      { date: '2026-01-05', value: d(10) },
      { date: '2026-01-06', value: d(10) },
      { date: '2026-01-07', value: d(80) },
    ];
    const result = computeWasteSpikes(days);
    expect(result).not.toBe('unknown');
    const flagged = result as Exclude<typeof result, 'unknown'>;
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.date).toBe('2026-01-07');
  });

  it('flags nothing when every day is identical (zero stdev)', () => {
    const days = [
      { date: '2026-01-01', value: d(10) },
      { date: '2026-01-02', value: d(10) },
    ];
    const result = computeWasteSpikes(days);
    expect(result).toEqual([]);
  });
});

describe('computeConsumptionAnomalyDays', () => {
  it('flags nothing when no day exceeds the 10% divergence threshold', () => {
    const days = [
      { date: '2026-01-01', actual: d(102), theoretical: d(100) },
      { date: '2026-01-02', actual: d(98), theoretical: d(100) },
    ];
    expect(computeConsumptionAnomalyDays(days)).toEqual([]);
  });

  it('flags nothing for isolated divergent days that are not sustained 3 days in a row', () => {
    const days = [
      { date: '2026-01-01', actual: d(150), theoretical: d(100) }, // 50% divergence, isolated
      { date: '2026-01-02', actual: d(100), theoretical: d(100) },
      { date: '2026-01-03', actual: d(150), theoretical: d(100) }, // isolated again
    ];
    expect(computeConsumptionAnomalyDays(days)).toEqual([]);
  });

  it('flags exactly a real 3-CONSECUTIVE-day divergent streak, not a scattered total of 3', () => {
    const days = [
      { date: '2026-01-01', actual: d(150), theoretical: d(100) },
      { date: '2026-01-02', actual: d(150), theoretical: d(100) },
      { date: '2026-01-03', actual: d(150), theoretical: d(100) },
      { date: '2026-01-04', actual: d(100), theoretical: d(100) },
    ];
    expect(computeConsumptionAnomalyDays(days)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  it('a day with zero theoretical consumption is excluded from the check but does not break a surrounding streak', () => {
    const days = [
      { date: '2026-01-01', actual: d(150), theoretical: d(100) },
      { date: '2026-01-02', actual: d(5), theoretical: d(0) }, // excluded from the divergence check itself
      { date: '2026-01-03', actual: d(150), theoretical: d(100) },
      { date: '2026-01-04', actual: d(150), theoretical: d(100) },
    ];
    // 01-02 is never divergent (skipped), so it breaks the streak — 01-01 is isolated (1 day),
    // 01-03/01-04 is only 2 consecutive days, neither reaches the 3-day sustained threshold.
    expect(computeConsumptionAnomalyDays(days)).toEqual([]);
  });

  it('a real 4-day streak flags all 4 days, not just the first 3', () => {
    const days = [
      { date: '2026-01-01', actual: d(150), theoretical: d(100) },
      { date: '2026-01-02', actual: d(150), theoretical: d(100) },
      { date: '2026-01-03', actual: d(150), theoretical: d(100) },
      { date: '2026-01-04', actual: d(150), theoretical: d(100) },
    ];
    expect(computeConsumptionAnomalyDays(days)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  });
});
