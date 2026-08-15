import { describe, expect, it } from 'vitest';
import { money, type Money } from '@retailos/domain';
import {
  computeExpiredValue,
  computeShrinkagePercentage,
  computeShrinkageValue,
  computeWastePercentage,
  computeWasteValueForReason,
} from './waste';

const usd = (v: string | number): Money => money(v, 'USD');

describe('computeWastePercentage', () => {
  it('divides waste value by cogs', () => {
    expect(computeWastePercentage(usd('20'), usd('200'))).toBe(10);
  });

  it('is unknown when waste value is unknown', () => {
    expect(computeWastePercentage('unknown', usd('200'))).toBe('unknown');
  });

  it('is unknown when cogs is unknown', () => {
    expect(computeWastePercentage(usd('20'), 'unknown')).toBe('unknown');
  });

  it('is unknown when cogs is zero, never a fabricated infinite%', () => {
    expect(computeWastePercentage(usd('20'), usd('0'))).toBe('unknown');
  });

  it('zero waste with real cogs is a genuine 0%, not unknown', () => {
    expect(computeWastePercentage(usd('0'), usd('200'))).toBe(0);
  });
});

describe('computeShrinkageValue', () => {
  it('sums signed variance values across approved counts', () => {
    const result = computeShrinkageValue(
      [{ varianceValue: '-15.0000' }, { varianceValue: '-5.0000' }, { varianceValue: '3.0000' }],
      'USD'
    );
    // -15 - 5 + 3 = -17.
    expect(result.amount.toFixed(2)).toBe('-17.00');
  });

  it('net surplus produces a positive value, not clamped to zero', () => {
    const result = computeShrinkageValue([{ varianceValue: '10.0000' }, { varianceValue: '5.0000' }], 'USD');
    expect(result.amount.toFixed(2)).toBe('15.00');
  });

  it('no approved counts in the period is a real zero, never unknown', () => {
    const result = computeShrinkageValue([], 'USD');
    expect(result.amount.toFixed(2)).toBe('0.00');
  });
});

describe('computeShrinkagePercentage', () => {
  it('divides shrinkage value by cogs, preserving sign', () => {
    expect(computeShrinkagePercentage(usd('-17'), usd('200'))).toBe(-8.5);
  });

  it('a net-surplus shrinkage value produces a positive percentage', () => {
    expect(computeShrinkagePercentage(usd('15'), usd('200'))).toBe(7.5);
  });

  it('is unknown when cogs is unknown', () => {
    expect(computeShrinkagePercentage(usd('-17'), 'unknown')).toBe('unknown');
  });

  it('is unknown when cogs is zero', () => {
    expect(computeShrinkagePercentage(usd('-17'), usd('0'))).toBe('unknown');
  });
});

describe('computeWasteValueForReason', () => {
  it('sums only lines matching the given reason code', () => {
    const result = computeWasteValueForReason(
      [
        { reasonCode: 'EXPIRED', value: usd('10') },
        { reasonCode: 'DAMAGED', value: usd('99') },
        { reasonCode: 'EXPIRED', value: usd('5') },
      ],
      'EXPIRED',
      'USD'
    );
    expect(result).not.toBe('unknown');
    expect((result as Money).amount.toFixed(2)).toBe('15.00');
  });

  it('is unknown if any MATCHING line has an unknown cost, unaffected by other reasons', () => {
    const result = computeWasteValueForReason(
      [
        { reasonCode: 'EXPIRED', value: 'unknown' },
        { reasonCode: 'DAMAGED', value: usd('99') },
      ],
      'EXPIRED',
      'USD'
    );
    expect(result).toBe('unknown');
  });

  it('no lines for the reason code is a real zero', () => {
    const result = computeWasteValueForReason([{ reasonCode: 'DAMAGED', value: usd('99') }], 'EXPIRED', 'USD');
    expect((result as Money).amount.toFixed(2)).toBe('0.00');
  });
});

describe('computeExpiredValue', () => {
  it('is equivalent to waste_by_reason for EXPIRED', () => {
    const lines = [
      { reasonCode: 'EXPIRED', value: usd('10') },
      { reasonCode: 'SPILLAGE', value: usd('4') },
    ];
    const expired = computeExpiredValue(lines, 'USD');
    const viaGeneric = computeWasteValueForReason(lines, 'EXPIRED', 'USD');
    expect(expired).not.toBe('unknown');
    expect((expired as Money).amount.toFixed(2)).toBe((viaGeneric as Money).amount.toFixed(2));
  });
});
