import { describe, expect, it } from 'vitest';
import { money, type Money } from '@retailos/domain';
import {
  computeDaysOfSupply,
  computeDeadStockValue,
  computeExpiryRiskValue,
  computeInventoryTurnover,
  computeNegativeStockIncidentCount,
  computeStockValueByCategory,
  computeStockoutEventCount,
  computeStockoutRevenueImpact,
  computeTotalStockValue,
} from './inventory';

const usd = (v: string | number): Money => money(v, 'USD');

describe('computeStockValueByCategory / computeTotalStockValue', () => {
  it('groups by category and sorts biggest first, including an uncategorized bucket', () => {
    const result = computeStockValueByCategory(
      [
        { categoryId: 'cat-a', totalValue: '100.0000' },
        { categoryId: null, totalValue: '250.0000' },
        { categoryId: 'cat-b', totalValue: '50.0000' },
      ],
      'USD'
    );
    expect(result).toHaveLength(3);
    expect(result[0]!.categoryId).toBeNull();
    expect(result[0]!.value.amount.toFixed(2)).toBe('250.00');
    expect(result[2]!.categoryId).toBe('cat-b');

    const total = computeTotalStockValue(result, 'USD');
    expect(total.amount.toFixed(2)).toBe('400.00');
  });

  it('no stock at all is a real zero, not unknown', () => {
    expect(computeTotalStockValue([], 'USD').amount.toFixed(2)).toBe('0.00');
  });
});

describe('computeDaysOfSupply', () => {
  it('divides stock on hand by average daily consumption', () => {
    expect(computeDaysOfSupply('100', '5')).toBe('20.00');
  });

  it('is unknown with no consumption history, never a fabricated "infinite" or zero', () => {
    expect(computeDaysOfSupply('100', null)).toBe('unknown');
  });

  it('is unknown for a non-positive average daily consumption', () => {
    expect(computeDaysOfSupply('100', '0')).toBe('unknown');
  });
});

describe('computeInventoryTurnover', () => {
  it('annualizes cogs/avg-stock-value for a period shorter than a year', () => {
    // 30-day period, cogs $300, avg stock value $100 -> raw 3.0 -> annualized 3.0 * 365/30 = 36.5.
    const result = computeInventoryTurnover(usd('300'), usd('100'), 30);
    expect(result).toBe(36.5);
  });

  it('is unknown when cogs is unknown', () => {
    expect(computeInventoryTurnover('unknown', usd('100'), 30)).toBe('unknown');
  });

  it('is unknown when average stock value is zero, never a fabricated infinite turnover', () => {
    expect(computeInventoryTurnover(usd('300'), usd('0'), 30)).toBe('unknown');
  });
});

describe('computeDeadStockValue', () => {
  it('sums quantity times avg unit cost across dead-stock lines', () => {
    const result = computeDeadStockValue(
      [
        { quantity: '10', avgUnitCost: usd('2.00') },
        { quantity: '5', avgUnitCost: usd('3.00') },
      ],
      'USD'
    );
    expect(result.total).not.toBe('unknown');
    expect((result.total as Money).amount.toFixed(2)).toBe('35.00');
    expect(result.unknownCostLineCount).toBe(0);
  });

  it('is unknown if ANY line has an unknown cost, never a partial sum, and surfaces the count', () => {
    const result = computeDeadStockValue(
      [
        { quantity: '10', avgUnitCost: usd('2.00') },
        { quantity: '5', avgUnitCost: 'unknown' },
      ],
      'USD'
    );
    expect(result.total).toBe('unknown');
    expect(result.unknownCostLineCount).toBe(1);
  });

  it('no dead stock at all is a real zero', () => {
    const result = computeDeadStockValue([], 'USD');
    expect((result.total as Money).amount.toFixed(2)).toBe('0.00');
  });
});

describe('computeExpiryRiskValue', () => {
  it('sums valueAtRisk only for lines within the horizon', () => {
    const result = computeExpiryRiskValue(
      [
        { valueAtRisk: '100.0000', daysToExpiry: 5 },
        { valueAtRisk: '200.0000', daysToExpiry: 20 },
      ],
      7,
      'USD'
    );
    expect(result.amount.toFixed(2)).toBe('100.00');
  });

  it('a boundary day (exactly the horizon) is included', () => {
    const result = computeExpiryRiskValue([{ valueAtRisk: '50.0000', daysToExpiry: 7 }], 7, 'USD');
    expect(result.amount.toFixed(2)).toBe('50.00');
  });

  it('no lines within the horizon is a real zero', () => {
    const result = computeExpiryRiskValue([{ valueAtRisk: '100.0000', daysToExpiry: 30 }], 7, 'USD');
    expect(result.amount.toFixed(2)).toBe('0.00');
  });
});

describe('computeStockoutEventCount', () => {
  it('counts the rows passed in', () => {
    expect(
      computeStockoutEventCount([
        { productId: 'a', variantId: 'v', stockoutDate: '2026-01-01' },
        { productId: 'a', variantId: 'v', stockoutDate: '2026-01-02' },
      ])
    ).toBe(2);
  });

  it('zero stockout days is a real zero', () => {
    expect(computeStockoutEventCount([])).toBe(0);
  });
});

describe('computeStockoutRevenueImpact', () => {
  it('estimates lost revenue as stockout days times avg daily consumption times avg unit price', () => {
    const result = computeStockoutRevenueImpact(
      { stockoutDayCount: 3, avgDailyConsumption: '5', avgUnitPrice: usd('10.00') },
      'USD'
    );
    expect(result.estimatedImpact).not.toBe('unknown');
    // 3 days * 5 units/day * $10 = $150.
    expect((result.estimatedImpact as Money).amount.toFixed(2)).toBe('150.00');
  });

  it('is unknown when consumption history is unknown, never a fabricated estimate', () => {
    const result = computeStockoutRevenueImpact(
      { stockoutDayCount: 3, avgDailyConsumption: null, avgUnitPrice: usd('10.00') },
      'USD'
    );
    expect(result.estimatedImpact).toBe('unknown');
  });

  it('is unknown when the selling price is unknown', () => {
    const result = computeStockoutRevenueImpact(
      { stockoutDayCount: 3, avgDailyConsumption: '5', avgUnitPrice: 'unknown' },
      'USD'
    );
    expect(result.estimatedImpact).toBe('unknown');
  });

  it('zero stockout days is a real zero estimate, not unknown', () => {
    const result = computeStockoutRevenueImpact(
      { stockoutDayCount: 0, avgDailyConsumption: '5', avgUnitPrice: usd('10.00') },
      'USD'
    );
    expect((result.estimatedImpact as Money).amount.toFixed(2)).toBe('0.00');
  });
});

describe('computeNegativeStockIncidentCount', () => {
  it('counts the rows passed in', () => {
    expect(computeNegativeStockIncidentCount([{}, {}, {}])).toBe(3);
  });

  it('no negative stock is a real zero', () => {
    expect(computeNegativeStockIncidentCount([])).toBe(0);
  });
});
