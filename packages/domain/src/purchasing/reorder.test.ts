import { describe, expect, it } from 'vitest';
import { quantity } from '../primitives/quantity';
import { money } from '../primitives/money';
import { suggestReorder, roundUpToPackSize, enforceMoq, type ConsumptionDay, type ReorderInput } from './reorder';

const BASE_DATE = new Date('2026-01-01T00:00:00Z');
const daysAfterBase = (days: number): Date => new Date(BASE_DATE.getTime() + days * 24 * 60 * 60 * 1000);

const steadyHistory = (dailyAmount: number, days: number): ConsumptionDay[] =>
  Array.from({ length: days }, (_, i) => ({
    date: daysAfterBase(i),
    quantityConsumed: quantity(dailyAmount, 'kg'),
    isClosureDay: false,
  }));

describe('suggestReorder — concrete anchor matching plan.md\'s own worked example', () => {
  it('suggests a pack-rounded quantity with a full explanation when stock is low', () => {
    const input: ReorderInput = {
      stockOnHand: quantity(9, 'kg'),
      onOrder: quantity(0, 'kg'),
      consumptionHistory: steadyHistory(4.2, 20),
      supplier: { measuredLeadTimeDays: 2, contractedLeadTimeDays: 3, minOrderValue: null },
      supplierProduct: { packSize: quantity(12, 'kg') },
      unitPrice: null,
      coverageDays: 10,
    };

    const result = suggestReorder(input);

    expect(result).not.toBeNull();
    expect(result!.explanation.leadTimeDays).toBe(2); // measured takes priority over contracted
    expect(result!.explanation.dailyConsumption.amount.toString()).toBe('4.2');
    expect(result!.explanation.coverageDays.toString()).toBe('10');
    expect(result!.explanation.packSize?.amount.toString()).toBe('12');
    // Quantity must be a whole multiple of the 12kg pack size.
    expect(result!.quantity.amount.mod(12).toString()).toBe('0');
    expect(result!.quantity.amount.greaterThan(0)).toBe(true);
  });

  it('falls back to contracted lead time when no measured lead time exists yet (new supplier)', () => {
    const input: ReorderInput = {
      stockOnHand: quantity(0, 'kg'),
      onOrder: quantity(0, 'kg'),
      consumptionHistory: steadyHistory(2, 10),
      supplier: { measuredLeadTimeDays: null, contractedLeadTimeDays: 5, minOrderValue: null },
      supplierProduct: { packSize: null },
      unitPrice: null,
      coverageDays: 7,
    };
    const result = suggestReorder(input);
    expect(result).not.toBeNull();
    expect(result!.explanation.leadTimeDays).toBe(5);
  });
});

describe('suggestReorder — new products with no history get no suggestion, never a guess (I7)', () => {
  it('returns null for a product with zero consumption history', () => {
    const input: ReorderInput = {
      stockOnHand: quantity(5, 'kg'),
      onOrder: quantity(0, 'kg'),
      consumptionHistory: [],
      supplier: { measuredLeadTimeDays: 3, contractedLeadTimeDays: 3, minOrderValue: null },
      supplierProduct: { packSize: null },
      unitPrice: null,
      coverageDays: 10,
    };
    expect(suggestReorder(input)).toBeNull();
  });

  it('returns null when lead time is entirely unknown, even with real consumption history', () => {
    const input: ReorderInput = {
      stockOnHand: quantity(0, 'kg'),
      onOrder: quantity(0, 'kg'),
      consumptionHistory: steadyHistory(3, 10),
      supplier: { measuredLeadTimeDays: null, contractedLeadTimeDays: null, minOrderValue: null },
      supplierProduct: { packSize: null },
      unitPrice: null,
      coverageDays: 10,
    };
    expect(suggestReorder(input)).toBeNull();
  });
});

describe('suggestReorder — closures are excluded from consumption days, not counted as zero', () => {
  it('a closure day does not drag the trimmed mean toward zero', () => {
    const historyWithClosure: ConsumptionDay[] = [
      ...steadyHistory(10, 9),
      { date: daysAfterBase(9), quantityConsumed: null, isClosureDay: true },
    ];
    const historyWithoutClosureDay = steadyHistory(10, 9);

    const base = {
      stockOnHand: quantity(0, 'kg'),
      onOrder: quantity(0, 'kg'),
      supplier: { measuredLeadTimeDays: 2, contractedLeadTimeDays: 2, minOrderValue: null },
      supplierProduct: { packSize: null },
      unitPrice: null,
      coverageDays: 10,
    };

    const withClosure = suggestReorder({ ...base, consumptionHistory: historyWithClosure });
    const withoutClosure = suggestReorder({ ...base, consumptionHistory: historyWithoutClosureDay });

    expect(withClosure!.explanation.dailyConsumption.amount.toString()).toBe(
      withoutClosure!.explanation.dailyConsumption.amount.toString()
    );
  });
});

describe('suggestReorder — erratic demand is flagged with wider safety stock and lower confidence', () => {
  it('fewer measured days yields LOW confidence; 14+ yields HIGH', () => {
    const base = {
      stockOnHand: quantity(0, 'kg'),
      onOrder: quantity(0, 'kg'),
      supplier: { measuredLeadTimeDays: 2, contractedLeadTimeDays: 2, minOrderValue: null },
      supplierProduct: { packSize: null },
      unitPrice: null,
      coverageDays: 10,
    };

    const lowConfidence = suggestReorder({ ...base, consumptionHistory: steadyHistory(3, 3) });
    const highConfidence = suggestReorder({ ...base, consumptionHistory: steadyHistory(3, 20) });

    expect(lowConfidence!.confidence).toBe('LOW');
    expect(highConfidence!.confidence).toBe('HIGH');
  });
});

describe('roundUpToPackSize', () => {
  it('rounds a fractional need up to the next whole pack', () => {
    const result = roundUpToPackSize(quantity(25, 'kg'), quantity(12, 'kg'));
    expect(result.amount.toString()).toBe('36'); // ceil(25/12) = 3 packs * 12 = 36
  });

  it('leaves an exact multiple unchanged', () => {
    const result = roundUpToPackSize(quantity(24, 'kg'), quantity(12, 'kg'));
    expect(result.amount.toString()).toBe('24');
  });

  it('passes the quantity through unchanged when pack size is unknown (I7)', () => {
    const result = roundUpToPackSize(quantity(25, 'kg'), null);
    expect(result.amount.toString()).toBe('25');
  });

  it('returns zero for a non-positive need rather than a negative or partial pack', () => {
    const result = roundUpToPackSize(quantity(0, 'kg'), quantity(12, 'kg'));
    expect(result.amount.toString()).toBe('0');
  });
});

describe('enforceMoq', () => {
  it('raises quantity to clear the minimum order value, then re-rounds to pack size', () => {
    // 1kg @ $2/kg = $2 order value, but MOQ is $50 → need 25kg, rounded up to 36kg (3x12kg packs).
    const result = enforceMoq(quantity(1, 'kg'), money(50, 'USD'), money(2, 'USD'), quantity(12, 'kg'));
    expect(result.amount.toString()).toBe('36');
  });

  it('leaves quantity unchanged when the order already clears the minimum', () => {
    const result = enforceMoq(quantity(30, 'kg'), money(50, 'USD'), money(2, 'USD'), quantity(12, 'kg'));
    expect(result.amount.toString()).toBe('30');
  });

  it('passes through unchanged when no MOQ is configured', () => {
    const result = enforceMoq(quantity(1, 'kg'), null, money(2, 'USD'), null);
    expect(result.amount.toString()).toBe('1');
  });

  it('passes through unchanged when unit price is unknown, even with a real MOQ (I7 — cannot judge order value without a price)', () => {
    const result = enforceMoq(quantity(1, 'kg'), money(50, 'USD'), null, null);
    expect(result.amount.toString()).toBe('1');
  });
});

describe('suggestReorder — pack-size and MOQ never make a suggestion unorderable (property-adjacent anchor)', () => {
  it('a suggestion with both pack size and MOQ configured always clears the minimum order value', () => {
    const input: ReorderInput = {
      stockOnHand: quantity(0, 'kg'),
      onOrder: quantity(0, 'kg'),
      consumptionHistory: steadyHistory(1, 20),
      supplier: { measuredLeadTimeDays: 2, contractedLeadTimeDays: 2, minOrderValue: money(100, 'USD') },
      supplierProduct: { packSize: quantity(5, 'kg') },
      unitPrice: money(3, 'USD'),
      coverageDays: 10,
    };
    const result = suggestReorder(input);
    expect(result).not.toBeNull();

    const orderValue = result!.quantity.amount.times(3);
    expect(orderValue.greaterThanOrEqualTo(100)).toBe(true);
    expect(result!.quantity.amount.mod(5).toString()).toBe('0');
  });
});

describe('suggestReorder — projected stock at or above reorder point yields no suggestion', () => {
  it('returns null when current stock alone already exceeds what lead time will consume', () => {
    const input: ReorderInput = {
      stockOnHand: quantity(1000, 'kg'),
      onOrder: quantity(0, 'kg'),
      consumptionHistory: steadyHistory(1, 20),
      supplier: { measuredLeadTimeDays: 2, contractedLeadTimeDays: 2, minOrderValue: null },
      supplierProduct: { packSize: null },
      unitPrice: null,
      coverageDays: 10,
    };
    expect(suggestReorder(input)).toBeNull();
  });
});

describe('suggestReorder — unit safety (I6)', () => {
  it('propagates the stockOnHand unit through to the suggested quantity', () => {
    const input: ReorderInput = {
      stockOnHand: quantity(0, 'g'),
      onOrder: quantity(0, 'g'),
      consumptionHistory: Array.from({ length: 10 }, (_, i) => ({
        date: daysAfterBase(i),
        quantityConsumed: quantity(100, 'g'),
        isClosureDay: false,
      })),
      supplier: { measuredLeadTimeDays: 2, contractedLeadTimeDays: 2, minOrderValue: null },
      supplierProduct: { packSize: null },
      unitPrice: null,
      coverageDays: 10,
    };
    const result = suggestReorder(input);
    expect(result!.quantity.unit).toBe('g');
  });
});

describe('trimmed mean behavior via suggestReorder — outliers are dulled, not ignored', () => {
  it('one catering-order spike day does not dominate the daily-consumption estimate', () => {
    const historyWithSpike: ConsumptionDay[] = [
      ...steadyHistory(2, 19),
      { date: daysAfterBase(19), quantityConsumed: quantity(1000, 'kg'), isClosureDay: false },
    ];
    const result = suggestReorder({
      stockOnHand: quantity(0, 'kg'),
      onOrder: quantity(0, 'kg'),
      consumptionHistory: historyWithSpike,
      supplier: { measuredLeadTimeDays: 2, contractedLeadTimeDays: 2, minOrderValue: null },
      supplierProduct: { packSize: null },
      unitPrice: null,
      coverageDays: 10,
    });
    // Simple (untrimmed) mean would be ~52/day; trimmed mean should stay close to the steady 2/day.
    expect(result!.explanation.dailyConsumption.amount.lessThan(10)).toBe(true);
  });
});
