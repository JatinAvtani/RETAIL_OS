import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { money, type Money } from '@retailos/domain';
import Decimal from 'decimal.js';
import {
  computeMarginAttribution,
  computeMarginPerItem,
  computeTotalContribution,
  type AttributionItemPair,
} from './attribution';

const usd = (v: string | number): Money => money(v, 'USD');

describe('computeMarginPerItem', () => {
  it('subtracts unit cost from selling price', () => {
    const result = computeMarginPerItem(usd('12.00'), usd('4.50'));
    expect(result).not.toBe('unknown');
    expect((result as Money).amount.toFixed(2)).toBe('7.50');
  });

  it('is unknown when unit cost is unknown, never a fabricated margin', () => {
    expect(computeMarginPerItem(usd('12.00'), 'unknown')).toBe('unknown');
  });
});

describe('computeTotalContribution', () => {
  it('multiplies margin per item by units sold', () => {
    const result = computeTotalContribution(usd('7.50'), '20');
    expect(result).not.toBe('unknown');
    expect((result as Money).amount.toFixed(2)).toBe('150.00');
  });

  it('is unknown when margin per item is unknown', () => {
    expect(computeTotalContribution('unknown', '20')).toBe('unknown');
  });
});

describe('computeMarginAttribution', () => {
  const pair = (
    menuItemId: string,
    base: { price: string; cost: string; quantity: string } | null,
    comparison: { price: string; cost: string; quantity: string } | null
  ): AttributionItemPair => ({
    menuItemId,
    base: base ? { price: usd(base.price), cost: usd(base.cost), quantity: base.quantity } : null,
    comparison: comparison
      ? { price: usd(comparison.price), cost: usd(comparison.cost), quantity: comparison.quantity }
      : null,
  });

  it('decomposes a real two-item mix shift, and the four components sum exactly to the total change', () => {
    const items: AttributionItemPair[] = [
      pair('a', { price: '10', cost: '6', quantity: '100' }, { price: '11', cost: '6.5', quantity: '80' }),
      pair('b', { price: '5', cost: '3', quantity: '50' }, { price: '5', cost: '3', quantity: '120' }),
    ];

    const result = computeMarginAttribution(items, 'USD');

    expect(result.totalChange).not.toBe('unknown');
    expect(result.priceEffect).not.toBe('unknown');

    const sum = (result.priceEffect as Money).amount
      .plus((result.costEffect as Money).amount)
      .plus((result.mixEffect as Money).amount)
      .plus((result.volumeEffect as Money).amount);

    expect(sum.toFixed(6)).toBe((result.totalChange as Money).amount.toFixed(6));

    // Hand-derived real total: (11-6.5)*80 + (5-3)*120 - [(10-6)*100 + (5-3)*50] = 360+240 - [400+100] = 600-500 = 100.
    expect((result.totalChange as Money).amount.toFixed(2)).toBe('100.00');
  });

  it('a genuinely new item (no base-period sales) contributes real volume effect, not exclusion', () => {
    const items: AttributionItemPair[] = [
      pair('a', { price: '10', cost: '6', quantity: '100' }, { price: '11', cost: '6.5', quantity: '80' }),
      pair('b', { price: '5', cost: '3', quantity: '50' }, { price: '5', cost: '3', quantity: '120' }),
      pair('new-item', null, { price: '8', cost: '4', quantity: '30' }),
    ];

    const result = computeMarginAttribution(items, 'USD');
    expect(result.excludedItemIds).toEqual([]);

    const sum = (result.priceEffect as Money).amount
      .plus((result.costEffect as Money).amount)
      .plus((result.mixEffect as Money).amount)
      .plus((result.volumeEffect as Money).amount);
    expect(sum.toFixed(6)).toBe((result.totalChange as Money).amount.toFixed(6));
    // Real total: (11-6.5)*80 + (5-3)*120 + (8-4)*30 - [(10-6)*100 + (5-3)*50 + 0]
    //           = 360 + 240 + 120 - [400 + 100] = 720 - 500 = 220.
    expect((result.totalChange as Money).amount.toFixed(2)).toBe('220.00');
  });

  it('an item with an unknown cost in either period is excluded from the whole decomposition, never defaulted to zero', () => {
    const items: AttributionItemPair[] = [
      pair('a', { price: '10', cost: '6', quantity: '100' }, { price: '11', cost: '6.5', quantity: '80' }),
      {
        menuItemId: 'unknown-cost-item',
        base: { price: usd('5'), cost: 'unknown', quantity: '50' },
        comparison: { price: usd('5'), cost: usd('3'), quantity: '60' },
      },
    ];

    const result = computeMarginAttribution(items, 'USD');
    expect(result.excludedItemIds).toEqual(['unknown-cost-item']);
    // Only item 'a' remains — verify it still reconciles on its own.
    const sum = (result.priceEffect as Money).amount
      .plus((result.costEffect as Money).amount)
      .plus((result.mixEffect as Money).amount)
      .plus((result.volumeEffect as Money).amount);
    expect(sum.toFixed(6)).toBe((result.totalChange as Money).amount.toFixed(6));
  });

  it('is unknown (not zero) when every item is excluded or there are no items at all', () => {
    expect(computeMarginAttribution([], 'USD').totalChange).toBe('unknown');

    const allUnknown: AttributionItemPair[] = [
      {
        menuItemId: 'x',
        base: { price: usd('5'), cost: 'unknown', quantity: '10' },
        comparison: { price: usd('5'), cost: usd('3'), quantity: '10' },
      },
    ];
    const result = computeMarginAttribution(allUnknown, 'USD');
    expect(result.totalChange).toBe('unknown');
    expect(result.excludedItemIds).toEqual(['x']);
  });

  it('PROPERTY: the four components always sum exactly to the total change, for any random multi-item scenario', () => {
    const moneyArb = fc.integer({ min: 100, max: 10000 }).map((cents) => new Decimal(cents).dividedBy(100));
    const qtyArb = fc.integer({ min: 0, max: 500 });

    const itemArb = fc.record({
      p0: moneyArb,
      c0: moneyArb,
      q0: qtyArb,
      p1: moneyArb,
      c1: moneyArb,
      q1: qtyArb,
    });

    fc.assert(
      fc.property(fc.array(itemArb, { minLength: 1, maxLength: 8 }), (rows) => {
        const items: AttributionItemPair[] = rows.map((r, i) => ({
          menuItemId: `item-${i}`,
          base: { price: money(r.p0, 'USD'), cost: money(r.c0, 'USD'), quantity: r.q0.toString() },
          comparison: { price: money(r.p1, 'USD'), cost: money(r.c1, 'USD'), quantity: r.q1.toString() },
        }));

        const result = computeMarginAttribution(items, 'USD');
        if (result.totalChange === 'unknown') return; // all-zero-quantity edge case, nothing to reconcile

        const sum = (result.priceEffect as Money).amount
          .plus((result.costEffect as Money).amount)
          .plus((result.mixEffect as Money).amount)
          .plus((result.volumeEffect as Money).amount);

        // Decimal arithmetic throughout keeps this exact, not approximate.
        expect(sum.toFixed(8)).toBe((result.totalChange as Money).amount.toFixed(8));
      })
    );
  });
});
