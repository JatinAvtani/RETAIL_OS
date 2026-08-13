import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { detectPriceChange, DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT } from './price-change';

describe('detectPriceChange', () => {
  it('an identical price is never a significant change', () => {
    const result = detectPriceChange({
      oldUnitPrice: new Decimal('5.00'),
      newUnitPrice: new Decimal('5.00'),
      trailing12moQuantity: new Decimal('100'),
    });
    expect(result.isSignificantChange).toBe(false);
    expect(result.percentChange!.toNumber()).toBe(0);
    expect(result.priceDelta.toNumber()).toBe(0);
  });

  it('a change within the default 2% threshold is not significant', () => {
    // $5.00 -> $5.05 is exactly 1% — within the default 2% threshold.
    const result = detectPriceChange({
      oldUnitPrice: new Decimal('5.00'),
      newUnitPrice: new Decimal('5.05'),
      trailing12moQuantity: new Decimal('100'),
    });
    expect(result.isSignificantChange).toBe(false);
  });

  it('a change strictly beyond the default 2% threshold is significant', () => {
    // $5.00 -> $5.20 is 4% — beyond the default 2% threshold.
    const result = detectPriceChange({
      oldUnitPrice: new Decimal('5.00'),
      newUnitPrice: new Decimal('5.20'),
      trailing12moQuantity: new Decimal('1000'),
    });
    expect(result.isSignificantChange).toBe(true);
    expect(result.percentChange!.toNumber()).toBeCloseTo(0.04, 10);
  });

  it('a price DECREASE beyond threshold is also significant — a real drop is as actionable as a real rise', () => {
    const result = detectPriceChange({
      oldUnitPrice: new Decimal('10.00'),
      newUnitPrice: new Decimal('9.00'),
      trailing12moQuantity: new Decimal('500'),
    });
    expect(result.isSignificantChange).toBe(true);
    expect(result.priceDelta.toNumber()).toBe(-1);
  });

  it('computes the exact annualized_impact = delta_unit_price x trailing_12mo_quantity', () => {
    const result = detectPriceChange({
      oldUnitPrice: new Decimal('5.00'),
      newUnitPrice: new Decimal('6.00'),
      trailing12moQuantity: new Decimal('2000'),
    });
    expect(result.annualizedImpact).not.toBe('unknown');
    expect((result.annualizedImpact as Decimal).toNumber()).toBe(2000); // $1 delta x 2000 units
  });

  it('a null trailing quantity produces "unknown" impact, never a guessed dollar figure — I7', () => {
    const result = detectPriceChange({
      oldUnitPrice: new Decimal('5.00'),
      newUnitPrice: new Decimal('6.00'),
      trailing12moQuantity: null,
    });
    expect(result.annualizedImpact).toBe('unknown');
    // The percent-change verdict itself is still real and computable — only the DOLLAR figure is unknown.
    expect(result.isSignificantChange).toBe(true);
  });

  it('a zero old price produces a null percentChange (undefined percentage), never a fabricated Infinity or 0 — I7', () => {
    const result = detectPriceChange({
      oldUnitPrice: new Decimal('0'),
      newUnitPrice: new Decimal('5.00'),
      trailing12moQuantity: new Decimal('10'),
    });
    expect(result.percentChange).toBeNull();
    expect(result.isSignificantChange).toBe(false);
    // The dollar impact is still real and computable from the two real prices — a zero baseline
    // breaks the PERCENTAGE, not the underlying price delta itself.
    expect(result.annualizedImpact).not.toBe('unknown');
  });

  it('respects a custom threshold override', () => {
    // A 1% change, which passes the default 2% threshold but should fail a stricter 0.5% override.
    const result = detectPriceChange(
      { oldUnitPrice: new Decimal('100'), newUnitPrice: new Decimal('101'), trailing12moQuantity: new Decimal('50') },
      new Decimal('0.005')
    );
    expect(result.isSignificantChange).toBe(true);
  });

  it('DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT matches the documented 2% default', () => {
    expect(DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT.toNumber()).toBe(0.02);
  });
});
