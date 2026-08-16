import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { decomposeWithWeeklySeasonality, flagResidualOutliers, mean, median, populationStdev } from './statistics.js';

const d = (n: number) => new Decimal(n);

describe('mean', () => {
  it('computes the arithmetic mean exactly', () => {
    expect(mean([d(2), d(4), d(4), d(4), d(5), d(5), d(7), d(9)]).toNumber()).toBe(5);
  });
});

describe('populationStdev', () => {
  it('matches the textbook dataset already hand-verified elsewhere in this codebase (supplier-metrics.ts)', () => {
    // 2,4,4,4,5,5,7,9 -> population stdev exactly 2, the same anchor 009-09 used for computeLeadTimeVariance.
    expect(populationStdev([d(2), d(4), d(4), d(4), d(5), d(5), d(7), d(9)]).toNumber()).toBe(2);
  });
});

describe('median', () => {
  it('returns the middle value for an odd-length series', () => {
    expect(median([d(1), d(5), d(3)]).toNumber()).toBe(3);
  });

  it('averages the two middle values for an even-length series', () => {
    expect(median([d(1), d(2), d(3), d(4)]).toNumber()).toBe(2.5);
  });
});

describe('decomposeWithWeeklySeasonality', () => {
  it('is unknown with fewer than 14 days of data, never approximated', () => {
    const series = Array.from({ length: 13 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: d(100),
    }));
    expect(decomposeWithWeeklySeasonality(series)).toBe('unknown');
  });

  it('a perfectly flat series with zero real day-of-week effect decomposes to all-zero residuals', () => {
    const series = Array.from({ length: 21 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: d(100),
    }));
    const result = decomposeWithWeeklySeasonality(series);
    expect(result).not.toBe('unknown');
    const withResidual = (result as Exclude<typeof result, 'unknown'>).filter((r) => r.residual !== null);
    expect(withResidual.length).toBeGreaterThan(0);
    for (const point of withResidual) {
      expect(point.residual!.toNumber()).toBeCloseTo(0, 6);
    }
  });

  it('the first and last 3 days have a null trend — no partial/biased window is ever computed', () => {
    const series = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: d(100 + i),
    }));
    const result = decomposeWithWeeklySeasonality(series);
    expect(result).not.toBe('unknown');
    const withTrend = result as Exclude<typeof result, 'unknown'>;
    expect(withTrend[0]!.trend).toBeNull();
    expect(withTrend[1]!.trend).toBeNull();
    expect(withTrend[2]!.trend).toBeNull();
    expect(withTrend[3]!.trend).not.toBeNull();
    expect(withTrend[withTrend.length - 1]!.trend).toBeNull();
  });

  it('a real, sustained day-of-week effect is captured as a nonzero seasonal component, not folded into the trend', () => {
    // 3 full weeks. Every Sunday (weekday 0) is exactly +50 above an otherwise flat 100 baseline.
    // A centered 7-day window always contains exactly ONE Sunday regardless of alignment here, so
    // the trend itself is a constant (150 + 6*100)/7 = 107.142857 everywhere — partially absorbing
    // the spike, not the naive full +50. Hand-derived: Sunday deviation = 150-107.142857 =
    // 42.857143; non-Sunday deviation = 100-107.142857 = -7.142857. Verified independently before
    // asserting (the same "re-derive by hand, don't guess" discipline this project applies
    // everywhere) — this IS the correct behavior of a moving-average trend, not a code bug.
    const series: { date: string; value: Decimal }[] = [];
    const start = new Date('2026-01-04T00:00:00Z'); // a real Sunday
    for (let i = 0; i < 21; i++) {
      const date = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
      const isSunday = date.getUTCDay() === 0;
      series.push({ date: date.toISOString().slice(0, 10), value: d(isSunday ? 150 : 100) });
    }
    const result = decomposeWithWeeklySeasonality(series);
    expect(result).not.toBe('unknown');
    const withSeasonal = (result as Exclude<typeof result, 'unknown'>).filter(
      (r) => new Date(`${r.date}T00:00:00Z`).getUTCDay() === 0 && r.seasonal !== null
    );
    const trend = 750 / 7; // (150 + 6*100) / 7 — the constant centered-window trend in this fixture
    expect(withSeasonal.length).toBeGreaterThan(0);
    for (const point of withSeasonal) {
      expect(point.seasonal!.toNumber()).toBeCloseTo(150 - trend, 4);
    }
    const withNonSundaySeasonal = (result as Exclude<typeof result, 'unknown'>).filter(
      (r) => new Date(`${r.date}T00:00:00Z`).getUTCDay() !== 0 && r.seasonal !== null
    );
    expect(withNonSundaySeasonal.length).toBeGreaterThan(0);
    for (const point of withNonSundaySeasonal) {
      expect(point.seasonal!.toNumber()).toBeCloseTo(100 - trend, 4);
    }
  });
});

describe('flagResidualOutliers', () => {
  it('flags no points when every residual is within threshold', () => {
    const decomposition = [
      { date: '2026-01-01', actual: d(100), trend: d(100), seasonal: d(0), residual: d(1) },
      { date: '2026-01-02', actual: d(100), trend: d(100), seasonal: d(0), residual: d(-1) },
    ];
    expect(flagResidualOutliers(decomposition, d(2.5))).toEqual([]);
  });

  it('flags exactly the one real outlier point among otherwise-tight residuals', () => {
    // z-score is (x - mean)/stdev, not x/stdev — with only a couple of small baseline points, one
    // large outlier can pull the raw mean far enough that even the outlier's OWN z-score understates
    // it (verified by hand: 5 points [1,-1,1,-1,50] gives the outlier z=1.998, under the 2.5
    // threshold, even with correct demeaning — a real property of z-scores on tiny samples, not a
    // bug). More baseline points make the effect small enough for one real outlier to clear the
    // threshold cleanly — hand-derived: 10 baseline points alternating +1/-1 (mean 0 on their own)
    // plus one point at +50 gives mean=4.545455, stdev=14.405577, outlier z=3.1553.
    const baseline = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      actual: d(100),
      trend: d(100),
      seasonal: d(0),
      residual: i % 2 === 0 ? d(1) : d(-1),
    }));
    const decomposition = [
      ...baseline,
      { date: '2026-01-11', actual: d(150), trend: d(100), seasonal: d(0), residual: d(50) },
    ];
    const flagged = flagResidualOutliers(decomposition, d(2.5));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.date).toBe('2026-01-11');
    expect(Number(flagged[0]!.zScore)).toBeCloseTo(3.1553, 3);
  });

  it('never flags anything when every residual is identical (zero stdev), avoiding a division by zero', () => {
    const decomposition = [
      { date: '2026-01-01', actual: d(100), trend: d(100), seasonal: d(0), residual: d(5) },
      { date: '2026-01-02', actual: d(100), trend: d(100), seasonal: d(0), residual: d(5) },
    ];
    expect(flagResidualOutliers(decomposition, d(2.5))).toEqual([]);
  });
});
