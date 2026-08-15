import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { money, type Money } from '@retailos/domain';
import {
  computeAverageTransactionValue,
  computeDiscountRate,
  computeGrossRevenue,
  computeRefundRate,
  computeRevenuePerDaypart,
  computeSalesMix,
  computeTransactionCount,
  computeUnitsSold,
  type TransactionHeader,
} from './sales';

const usd = (v: string | number): Money => money(v, 'USD');

const header = (overrides: Partial<TransactionHeader> = {}): TransactionHeader => ({
  occurredAt: new Date('2026-06-01T12:00:00.000Z'),
  subtotal: usd('0'),
  discount: usd('0'),
  tax: usd('0'),
  total: usd('0'),
  status: 'COMPLETED',
  ...overrides,
});

describe('computeGrossRevenue', () => {
  it('sums subtotal over COMPLETED transactions only', () => {
    const result = computeGrossRevenue(
      [
        header({ subtotal: usd('50.00'), status: 'COMPLETED' }),
        header({ subtotal: usd('30.00'), status: 'COMPLETED' }),
        header({ subtotal: usd('999.00'), status: 'REFUNDED' }),
        header({ subtotal: usd('999.00'), status: 'VOIDED' }),
      ],
      'USD'
    );
    expect(result.amount.toFixed(2)).toBe('80.00');
  });

  it('no transactions is a real zero', () => {
    expect(computeGrossRevenue([], 'USD').amount.toFixed(2)).toBe('0.00');
  });
});

describe('computeTransactionCount', () => {
  it('counts only COMPLETED transactions', () => {
    const count = computeTransactionCount([
      header({ status: 'COMPLETED' }),
      header({ status: 'COMPLETED' }),
      header({ status: 'REFUNDED' }),
    ]);
    expect(count).toBe(2);
  });
});

describe('computeAverageTransactionValue', () => {
  it('divides net revenue by transaction count', () => {
    const result = computeAverageTransactionValue(usd('100.00'), 2);
    expect(result).not.toBe('unknown');
    expect((result as Money).amount.toFixed(2)).toBe('50.00');
  });

  it('is unknown for zero transactions, never a fabricated zero', () => {
    expect(computeAverageTransactionValue(usd('0.00'), 0)).toBe('unknown');
  });
});

describe('computeUnitsSold', () => {
  it('sums quantities to full decimal precision', () => {
    expect(computeUnitsSold(['1.5', '2.25', '3'])).toBe('6.750000');
  });

  it('no lines is a real zero', () => {
    expect(computeUnitsSold([])).toBe('0.000000');
  });
});

describe('computeDiscountRate', () => {
  it('divides total discount by gross revenue, over completed transactions', () => {
    const { rate, totalDiscount } = computeDiscountRate(
      [
        header({ subtotal: usd('100.00'), discount: usd('10.00'), status: 'COMPLETED' }),
        header({ subtotal: usd('50.00'), discount: usd('0.00'), status: 'COMPLETED' }),
      ],
      'USD'
    );
    // 10 / 150 = 6.67%
    expect(rate).toBe(6.67);
    expect(totalDiscount.amount.toFixed(2)).toBe('10.00');
  });

  it('is unknown at zero gross revenue, never a fabricated 0%', () => {
    const { rate } = computeDiscountRate([], 'USD');
    expect(rate).toBe('unknown');
  });
});

describe('computeRefundRate', () => {
  it('divides refunded total by gross revenue from completed transactions', () => {
    const { rate, totalRefunded } = computeRefundRate(
      [
        header({ subtotal: usd('200.00'), status: 'COMPLETED' }),
        header({ total: usd('50.00'), status: 'REFUNDED' }),
      ],
      'USD'
    );
    // 50 / 200 = 25%
    expect(rate).toBe(25);
    expect(totalRefunded.amount.toFixed(2)).toBe('50.00');
  });

  it('is unknown when there is no completed gross revenue in the period, even if refunds exist', () => {
    const { rate } = computeRefundRate([header({ total: usd('50.00'), status: 'REFUNDED' })], 'USD');
    expect(rate).toBe('unknown');
  });
});

describe('computeSalesMix', () => {
  it('groups revenue by item and computes percentages summing to 100', () => {
    const mix = computeSalesMix(
      [
        { itemId: 'a', itemName: 'Croissant', lineTotal: usd('75.00') },
        { itemId: 'b', itemName: 'Coffee', lineTotal: usd('25.00') },
      ],
      'USD'
    );
    expect(mix).toHaveLength(2);
    expect(mix[0]!.itemId).toBe('a'); // sorted biggest first
    expect(mix[0]!.percentage).toBe(75);
    expect(mix[1]!.percentage).toBe(25);
  });

  it('groups a null itemId under a real "Unmapped" entry, never drops it', () => {
    const mix = computeSalesMix(
      [
        { itemId: 'a', itemName: 'Croissant', lineTotal: usd('50.00') },
        { itemId: null, itemName: null, lineTotal: usd('50.00') },
      ],
      'USD'
    );
    expect(mix).toHaveLength(2);
    const unmapped = mix.find((m) => m.itemId === null);
    expect(unmapped?.itemName).toBe('Unmapped');
    expect(unmapped?.percentage).toBe(50);
  });

  it('empty input returns an empty mix, not a fabricated entry', () => {
    expect(computeSalesMix([], 'USD')).toEqual([]);
  });

  it('property: percentages always sum to ~100 for any non-empty positive input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 5 }), fc.integer({ min: 1, max: 10000 })), {
          minLength: 1,
          maxLength: 10,
        }),
        (entries) => {
          const lines = entries.map(([itemId, cents], i) => ({
            itemId: `${itemId}-${i}`,
            itemName: itemId,
            lineTotal: usd((cents / 100).toFixed(2)),
          }));
          const mix = computeSalesMix(lines, 'USD');
          const total = mix.reduce((sum, m) => sum + m.percentage, 0);
          // Decimal rounding to 2 places per entry can drift the sum by a small epsilon.
          expect(Math.abs(total - 100)).toBeLessThan(0.5);
        }
      )
    );
  });
});

describe('computeRevenuePerDaypart', () => {
  it('buckets revenue by LOCAL daypart, not UTC', () => {
    // 2026-06-01 17:00 UTC = 13:00 New York (LUNCH, UTC-4 daylight saving).
    const lunchLine = { occurredAt: new Date('2026-06-01T17:00:00.000Z'), lineTotal: usd('40.00') };
    // 2026-06-02 00:30 UTC = 20:30 New York previous day (DINNER).
    const dinnerLine = { occurredAt: new Date('2026-06-02T00:30:00.000Z'), lineTotal: usd('60.00') };

    const result = computeRevenuePerDaypart([lunchLine, dinnerLine], 'America/New_York', 'USD');
    expect(result.LUNCH.amount.toFixed(2)).toBe('40.00');
    expect(result.DINNER.amount.toFixed(2)).toBe('60.00');
    expect(result.BREAKFAST.amount.toFixed(2)).toBe('0.00');
    expect(result.LATE_NIGHT.amount.toFixed(2)).toBe('0.00');
  });

  it('every daypart is present with a real zero when unused, never omitted', () => {
    const result = computeRevenuePerDaypart([], 'UTC', 'USD');
    expect(result.BREAKFAST.amount.toFixed(2)).toBe('0.00');
    expect(result.LUNCH.amount.toFixed(2)).toBe('0.00');
    expect(result.DINNER.amount.toFixed(2)).toBe('0.00');
    expect(result.LATE_NIGHT.amount.toFixed(2)).toBe('0.00');
  });
});
