import { describe, expect, it } from 'vitest';
import { resolveUnitCostLatest, resolveUnitCostWeightedAvg } from './cost';

describe('resolveUnitCostWeightedAvg', () => {
  it('constructs a real Money from a stored average cost', () => {
    const result = resolveUnitCostWeightedAvg('3.2500', 'USD');
    expect(result).not.toBe('unknown');
    expect((result as { amount: { toFixed: (n: number) => string } }).amount.toFixed(2)).toBe('3.25');
  });

  it('is unknown when no average cost has ever been recorded, never a fabricated zero', () => {
    expect(resolveUnitCostWeightedAvg(null, 'USD')).toBe('unknown');
  });
});

describe('resolveUnitCostLatest', () => {
  it('constructs a real Money from the currently-effective price', () => {
    const result = resolveUnitCostLatest({ unitPrice: '12.5000', currency: 'USD' });
    expect(result).not.toBe('unknown');
    expect((result as { amount: { toFixed: (n: number) => string } }).amount.toFixed(2)).toBe('12.50');
  });

  it('is unknown when no currently-effective price exists', () => {
    expect(resolveUnitCostLatest(null)).toBe('unknown');
  });
});
