import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { money } from '@retailos/domain';
import { computeRecipeCost, type RecipeCostLine } from './recipe-cost';

describe('computeRecipeCost', () => {
  it('sums known lines into a real total', () => {
    const lines: RecipeCostLine[] = [
      { productId: 'flour', cost: money('2.50', 'USD') },
      { productId: 'sugar', cost: money('1.25', 'USD') },
    ];

    const result = computeRecipeCost(lines, 'USD');

    expect(result.total).not.toBe('unknown');
    expect((result.total as ReturnType<typeof money>).amount.toFixed(2)).toBe('3.75');
  });

  it('is unknown, never a partial sum, when exactly one line has no price', () => {
    const lines: RecipeCostLine[] = [
      { productId: 'flour', cost: money('2.50', 'USD') },
      { productId: 'mystery-ingredient', cost: 'unknown' },
    ];

    const result = computeRecipeCost(lines, 'USD');

    expect(result.total).toBe('unknown');
  });

  it('is unknown when every line has no price', () => {
    const lines: RecipeCostLine[] = [
      { productId: 'a', cost: 'unknown' },
      { productId: 'b', cost: 'unknown' },
    ];

    expect(computeRecipeCost(lines, 'USD').total).toBe('unknown');
  });

  it('a recipe with zero components costs exactly zero, distinct from unknown', () => {
    const result = computeRecipeCost([], 'USD');

    expect(result.total).not.toBe('unknown');
    expect((result.total as ReturnType<typeof money>).amount.toFixed(2)).toBe('0.00');
  });

  it('preserves every line, known and unknown, in the result regardless of the total', () => {
    const lines: RecipeCostLine[] = [
      { productId: 'flour', cost: money('2.50', 'USD') },
      { productId: 'mystery', cost: 'unknown' },
    ];

    const result = computeRecipeCost(lines, 'USD');

    expect(result.lines).toHaveLength(2);
    expect(result.lines.map((l) => l.productId)).toEqual(['flour', 'mystery']);
  });

  // the plan's costing-chain property test list: margin attribution components must sum exactly
  // to the total. Applied here one link earlier in the chain — the SAME property for recipe cost.
  it('property: the total exactly equals the sum of all known line amounts, for any all-known set of lines', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1 }), fc.double({ min: 0, max: 10000, noNaN: true })), {
          minLength: 1,
          maxLength: 20,
        }),
        (entries) => {
          const lines: RecipeCostLine[] = entries.map(([productId, amount]) => ({
            productId,
            cost: money(amount.toFixed(4), 'USD'),
          }));

          const result = computeRecipeCost(lines, 'USD');
          const expectedTotal = entries.reduce((sum, [, amount]) => sum + amount, 0);

          expect(result.total).not.toBe('unknown');
          const actual = (result.total as ReturnType<typeof money>).amount.toNumber();
          expect(actual).toBeCloseTo(expectedTotal, 2);
        }
      )
    );
  });

  // property: unknown is "infectious" — inserting exactly one unknown line anywhere in an
  // otherwise-fully-priced recipe always collapses the whole total to unknown, regardless of
  // how many known lines surround it or where it sits in the list.
  it('property: a single unknown line collapses the total to unknown regardless of position or how many known lines exist', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.01, max: 1000, noNaN: true }), { minLength: 0, maxLength: 10 }),
        fc.array(fc.double({ min: 0.01, max: 1000, noNaN: true }), { minLength: 0, maxLength: 10 }),
        (before, after) => {
          const lines: RecipeCostLine[] = [
            ...before.map((amount, i) => ({ productId: `before-${i}`, cost: money(amount.toFixed(4), 'USD') })),
            { productId: 'unknown-ingredient', cost: 'unknown' as const },
            ...after.map((amount, i) => ({ productId: `after-${i}`, cost: money(amount.toFixed(4), 'USD') })),
          ];

          expect(computeRecipeCost(lines, 'USD').total).toBe('unknown');
        }
      )
    );
  });
});
