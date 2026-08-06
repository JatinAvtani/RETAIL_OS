import { describe, expect, it } from 'vitest';
import { money, type Money } from '@retailos/domain';
import {
  computeCogsActual,
  computeCogsTheoretical,
  computeContributionMargin,
  computeContributionMarginPercentage,
  computeCostVariance,
  computeFoodCostPercentage,
  computeNetRevenue,
  computeWasteBreakdown,
} from './margin';

const usd = (v: string | number): Money => money(v, 'USD');

describe('computeNetRevenue', () => {
  it('sums line totals', () => {
    const result = computeNetRevenue([usd('10.00'), usd('5.50'), usd('2.25')], 'USD');
    expect(result.amount.toFixed(2)).toBe('17.75');
  });

  it('an empty period is a real zero, not unknown — nothing was sold', () => {
    const result = computeNetRevenue([], 'USD');
    expect(result.amount.toFixed(2)).toBe('0.00');
  });
});

describe('computeCogsActual', () => {
  it('sums the real cost of each consumed lot', () => {
    const result = computeCogsActual(
      [
        { productId: 'a', quantity: '10', cost: usd('4.00') },
        { productId: 'b', quantity: '5', cost: usd('1.50') },
      ],
      'USD'
    );
    expect(result).not.toBe('unknown');
    expect((result as Money).amount.toFixed(2)).toBe('5.50');
  });

  it('is unknown if ANY line has an unknown lot cost — never a partial sum', () => {
    const result = computeCogsActual(
      [
        { productId: 'a', quantity: '10', cost: usd('4.00') },
        { productId: 'b', quantity: '5', cost: 'unknown' },
      ],
      'USD'
    );
    expect(result).toBe('unknown');
  });

  it('no consumption at all is a real zero', () => {
    expect(computeCogsActual([], 'USD')).not.toBe('unknown');
  });
});

describe('computeCogsTheoretical', () => {
  it('multiplies each sold quantity by its unit recipe cost', () => {
    // 3 loaves @ $1.25 + 10 coffees @ $0.60 = 3.75 + 6.00 = 9.75
    const result = computeCogsTheoretical(
      [
        { menuItemId: 'loaf', quantitySold: '3', unitRecipeCost: usd('1.25') },
        { menuItemId: 'coffee', quantitySold: '10', unitRecipeCost: usd('0.60') },
      ],
      'USD'
    );
    expect((result as Money).amount.toFixed(2)).toBe('9.75');
  });

  it('handles fractional quantities without float drift', () => {
    // 0.1 + 0.2 style case: 3 x 0.10 must be exactly 0.30, not 0.30000000000000004
    const result = computeCogsTheoretical(
      [{ menuItemId: 'x', quantitySold: '3', unitRecipeCost: usd('0.10') }],
      'USD'
    );
    expect((result as Money).amount.toFixed(2)).toBe('0.30');
  });

  it('is unknown if any recipe cost is unknown', () => {
    const result = computeCogsTheoretical(
      [
        { menuItemId: 'a', quantitySold: '1', unitRecipeCost: usd('1.00') },
        { menuItemId: 'b', quantitySold: '1', unitRecipeCost: 'unknown' },
      ],
      'USD'
    );
    expect(result).toBe('unknown');
  });
});

describe('computeCostVariance', () => {
  it('actual above theoretical is reported as over-consumption', () => {
    const result = computeCostVariance(usd('120.00'), usd('100.00'));
    expect((result.variance as Money).amount.toFixed(2)).toBe('20.00');
    expect(result.direction).toBe('over');
  });

  it('actual below theoretical is reported as under', () => {
    const result = computeCostVariance(usd('90.00'), usd('100.00'));
    expect((result.variance as Money).amount.toFixed(2)).toBe('-10.00');
    expect(result.direction).toBe('under');
  });

  it('exact match reports no variance', () => {
    const result = computeCostVariance(usd('100.00'), usd('100.00'));
    expect(result.direction).toBe('exact');
  });

  it('is unknown when either side is unknown — never treats unknown as zero', () => {
    expect(computeCostVariance('unknown', usd('100.00')).variance).toBe('unknown');
    expect(computeCostVariance(usd('100.00'), 'unknown').variance).toBe('unknown');
    expect(computeCostVariance('unknown', 'unknown').direction).toBe('unknown');
  });
});

describe('computeContributionMargin', () => {
  it('is revenue minus actual COGS', () => {
    const result = computeContributionMargin(usd('500.00'), usd('180.00'));
    expect((result as Money).amount.toFixed(2)).toBe('320.00');
  });

  it('is unknown when COGS is unknown — a margin computed against a guess is a fabricated number', () => {
    expect(computeContributionMargin(usd('500.00'), 'unknown')).toBe('unknown');
  });
});

describe('computeFoodCostPercentage', () => {
  it('is COGS as a percentage of revenue', () => {
    expect(computeFoodCostPercentage(usd('30.00'), usd('100.00'))).toBe(30);
  });

  it('rounds to two decimal places', () => {
    expect(computeFoodCostPercentage(usd('33.333'), usd('100.00'))).toBe(33.33);
  });

  it('is unknown when COGS is unknown', () => {
    expect(computeFoodCostPercentage('unknown', usd('100.00'))).toBe('unknown');
  });

  it('is unknown at zero revenue — 0% would read as perfect cost control, not "sold nothing"', () => {
    expect(computeFoodCostPercentage(usd('0.00'), usd('0.00'))).toBe('unknown');
  });
});

describe('computeContributionMarginPercentage', () => {
  it('is margin as a percentage of revenue', () => {
    expect(computeContributionMarginPercentage(usd('70.00'), usd('100.00'))).toBe(70);
  });

  it('is unknown at zero revenue', () => {
    expect(computeContributionMarginPercentage(usd('0.00'), usd('0.00'))).toBe('unknown');
  });

  it('is unknown when the margin itself is unknown', () => {
    expect(computeContributionMarginPercentage('unknown', usd('100.00'))).toBe('unknown');
  });
});

describe('computeWasteBreakdown', () => {
  it('groups by reason code and sorts biggest loss first', () => {
    const result = computeWasteBreakdown(
      [
        { reasonCode: 'SPILLAGE', value: usd('5.00') },
        { reasonCode: 'EXPIRED', value: usd('12.00') },
        { reasonCode: 'SPILLAGE', value: usd('3.00') },
      ],
      'USD'
    );

    expect(result.byReason.map((r) => r.reasonCode)).toEqual(['EXPIRED', 'SPILLAGE']);
    expect(result.byReason[0]!.value.amount.toFixed(2)).toBe('12.00');
    expect(result.byReason[1]!.value.amount.toFixed(2)).toBe('8.00');
    expect((result.total as Money).amount.toFixed(2)).toBe('20.00');
    expect(result.unknownCostEventCount).toBe(0);
  });

  it('an unknown-cost event makes the TOTAL unknown but still reports what is known', () => {
    const result = computeWasteBreakdown(
      [
        { reasonCode: 'SPILLAGE', value: usd('5.00') },
        { reasonCode: 'EXPIRED', value: 'unknown' },
      ],
      'USD'
    );

    expect(result.total).toBe('unknown');
    expect(result.unknownCostEventCount).toBe(1);
    // The known portion is still surfaced — an unexplained "unknown" with nothing else is useless.
    expect(result.byReason).toHaveLength(1);
    expect(result.byReason[0]!.value.amount.toFixed(2)).toBe('5.00');
  });

  it('no waste at all is a real zero', () => {
    const result = computeWasteBreakdown([], 'USD');
    expect((result.total as Money).amount.toFixed(2)).toBe('0.00');
    expect(result.byReason).toEqual([]);
  });
});

describe('the chain end to end', () => {
  it('revenue 500, actual COGS 180, theoretical 150 → margin 320, food cost 36%, variance +30 over', () => {
    const revenue = computeNetRevenue([usd('300.00'), usd('200.00')], 'USD');
    const actual = computeCogsActual(
      [
        { productId: 'flour', quantity: '1', cost: usd('100.00') },
        { productId: 'butter', quantity: '1', cost: usd('80.00') },
      ],
      'USD'
    );
    const theoretical = computeCogsTheoretical(
      [{ menuItemId: 'loaf', quantitySold: '100', unitRecipeCost: usd('1.50') }],
      'USD'
    );

    expect(revenue.amount.toFixed(2)).toBe('500.00');
    expect((actual as Money).amount.toFixed(2)).toBe('180.00');
    expect((theoretical as Money).amount.toFixed(2)).toBe('150.00');

    const margin = computeContributionMargin(revenue, actual);
    expect((margin as Money).amount.toFixed(2)).toBe('320.00');
    expect(computeFoodCostPercentage(actual, revenue)).toBe(36);
    expect(computeContributionMarginPercentage(margin, revenue)).toBe(64);

    const variance = computeCostVariance(actual, theoretical);
    expect((variance.variance as Money).amount.toFixed(2)).toBe('30.00');
    expect(variance.direction).toBe('over');
  });

  it('one unknown lot cost propagates through the whole chain rather than silently inflating margin', () => {
    const revenue = computeNetRevenue([usd('500.00')], 'USD');
    const actual = computeCogsActual(
      [
        { productId: 'flour', quantity: '1', cost: usd('100.00') },
        { productId: 'mystery', quantity: '1', cost: 'unknown' },
      ],
      'USD'
    );

    expect(actual).toBe('unknown');
    expect(computeContributionMargin(revenue, actual)).toBe('unknown');
    expect(computeFoodCostPercentage(actual, revenue)).toBe('unknown');
    expect(computeCostVariance(actual, usd('150.00')).variance).toBe('unknown');
  });
});
