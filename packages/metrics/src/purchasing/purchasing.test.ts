import { describe, expect, it } from 'vitest';
import { money, type Money } from '@retailos/domain';
import {
  computeAverageOrderValue,
  computeEmergencyPurchaseRate,
  computeOrderFrequency,
  computePoCycleTime,
  computePriceChangeImpact,
  computePriceVarianceTotal,
  computeSpendByCategory,
  computeTotalSpend,
} from './purchasing';

const usd = (v: string | number): Money => money(v, 'USD');

describe('computeSpendByCategory / computeTotalSpend', () => {
  it('groups approved PO line totals by category and sorts biggest first, including an uncategorized bucket', () => {
    const result = computeSpendByCategory(
      [
        { categoryId: 'cat-a', lineTotal: '100.0000' },
        { categoryId: null, lineTotal: '250.0000' },
        { categoryId: 'cat-a', lineTotal: '50.0000' },
      ],
      'USD'
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.categoryId).toBeNull();
    expect(result[0]!.value.amount.toFixed(2)).toBe('250.00');
    expect(result[1]!.categoryId).toBe('cat-a');
    expect(result[1]!.value.amount.toFixed(2)).toBe('150.00');

    const total = computeTotalSpend(result, 'USD');
    expect(total.amount.toFixed(2)).toBe('400.00');
  });

  it('no approved spend at all is a real zero, not unknown', () => {
    expect(computeTotalSpend([], 'USD').amount.toFixed(2)).toBe('0.00');
  });
});

describe('computePriceVarianceTotal', () => {
  it('sums priceVariance times invoiceQuantity across lines', () => {
    const result = computePriceVarianceTotal(
      [
        { priceVariance: '0.50', invoiceQuantity: '10' },
        { priceVariance: '-0.25', invoiceQuantity: '4' },
      ],
      'USD'
    );
    // (0.50 * 10) + (-0.25 * 4) = 5.00 - 1.00 = 4.00.
    expect(result.amount.toFixed(2)).toBe('4.00');
  });

  it('no variance lines is a real zero', () => {
    expect(computePriceVarianceTotal([], 'USD').amount.toFixed(2)).toBe('0.00');
  });
});

describe('computePriceChangeImpact', () => {
  it('reads the most recent PRICE_CHANGE event\'s already-computed variance', () => {
    const result = computePriceChangeImpact(
      [
        { variance: '100.00', occurredAt: new Date('2026-01-01T00:00:00Z') },
        { variance: '500.00', occurredAt: new Date('2026-02-01T00:00:00Z') },
      ],
      'USD'
    );
    expect(result).not.toBe('unknown');
    expect((result as Money).amount.toFixed(2)).toBe('500.00');
  });

  it('is unknown with no PRICE_CHANGE events at all, never a fabricated zero', () => {
    expect(computePriceChangeImpact([], 'USD')).toBe('unknown');
  });

  it('is unknown when the most recent event has a null variance (no trailing history at detection time)', () => {
    const result = computePriceChangeImpact(
      [{ variance: null, occurredAt: new Date('2026-01-01T00:00:00Z') }],
      'USD'
    );
    expect(result).toBe('unknown');
  });

  it('a negative variance (a price decrease) is preserved as-is', () => {
    const result = computePriceChangeImpact(
      [{ variance: '-500.00', occurredAt: new Date('2026-01-01T00:00:00Z') }],
      'USD'
    );
    expect((result as Money).amount.toFixed(2)).toBe('-500.00');
  });
});

describe('computePoCycleTime', () => {
  it('averages days from createdAt to sentAt', () => {
    const result = computePoCycleTime([
      { createdAt: new Date('2026-01-01T00:00:00Z'), sentAt: new Date('2026-01-02T00:00:00Z') },
      { createdAt: new Date('2026-01-05T00:00:00Z'), sentAt: new Date('2026-01-06T12:00:00Z') },
    ]);
    // (1 + 1.5) / 2 = 1.25 days.
    expect(result).toBe(1.25);
  });

  it('is unknown with zero sent POs in the period, never a fabricated 0-day average', () => {
    expect(computePoCycleTime([])).toBe('unknown');
  });
});

describe('computeOrderFrequency', () => {
  it('is a plain count', () => {
    expect(computeOrderFrequency(7)).toBe(7);
  });

  it('zero POs is a real zero', () => {
    expect(computeOrderFrequency(0)).toBe(0);
  });
});

describe('computeAverageOrderValue', () => {
  it('divides total spend by PO count', () => {
    const result = computeAverageOrderValue(usd('1000'), 4, 'USD');
    expect((result as Money).amount.toFixed(2)).toBe('250.00');
  });

  it('is unknown with zero POs, never a fabricated $0 average', () => {
    expect(computeAverageOrderValue(usd('0'), 0, 'USD')).toBe('unknown');
  });
});

describe('computeEmergencyPurchaseRate', () => {
  it('divides receipts without a PO by all receipts', () => {
    expect(computeEmergencyPurchaseRate(3, 12)).toBe(25);
  });

  it('is unknown with zero receipts in the period, never a fabricated 0%', () => {
    expect(computeEmergencyPurchaseRate(0, 0)).toBe('unknown');
  });

  it('zero emergency receipts against real total receipts is a genuine 0%, not unknown', () => {
    expect(computeEmergencyPurchaseRate(0, 10)).toBe(0);
  });
});
