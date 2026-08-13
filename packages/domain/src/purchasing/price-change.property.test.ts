import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { detectPriceChange, DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT } from './price-change';

const positiveCents = fc.integer({ min: 1, max: 1_000_000 }).map((c) => new Decimal(c).dividedBy(100));
const quantityValue = fc.integer({ min: 0, max: 1_000_000 }).map((q) => new Decimal(q).dividedBy(100));

describe('detectPriceChange — property tests', () => {
  it('annualizedImpact always equals priceDelta * trailing12moQuantity exactly, whenever a quantity exists', () => {
    fc.assert(
      fc.property(positiveCents, positiveCents, quantityValue, (oldPrice, newPrice, qty) => {
        const result = detectPriceChange({ oldUnitPrice: oldPrice, newUnitPrice: newPrice, trailing12moQuantity: qty });
        const expected = newPrice.minus(oldPrice).times(qty);
        expect(result.annualizedImpact).not.toBe('unknown');
        expect((result.annualizedImpact as Decimal).equals(expected)).toBe(true);
      })
    );
  });

  it('a price change strictly beyond the threshold is always flagged significant, regardless of magnitude', () => {
    fc.assert(
      fc.property(positiveCents, positiveCents, quantityValue, (oldPrice, delta, qty) => {
        // Force a delta guaranteed to exceed the default 2% threshold.
        const guaranteedExcess = Decimal.max(delta, oldPrice.times('0.5').plus(1));
        const newPrice = oldPrice.plus(guaranteedExcess);
        const result = detectPriceChange({ oldUnitPrice: oldPrice, newUnitPrice: newPrice, trailing12moQuantity: qty });
        expect(result.isSignificantChange).toBe(true);
      })
    );
  });

  it('a null trailing quantity never fabricates a numeric annualizedImpact, for any real price pair', () => {
    fc.assert(
      fc.property(positiveCents, positiveCents, (oldPrice, newPrice) => {
        const result = detectPriceChange({ oldUnitPrice: oldPrice, newUnitPrice: newPrice, trailing12moQuantity: null });
        expect(result.annualizedImpact).toBe('unknown');
      })
    );
  });

  it('percentChange is always null when and only when the old price is zero', () => {
    fc.assert(
      fc.property(fc.option(positiveCents, { nil: null }), positiveCents, quantityValue, (oldPriceOrNull, newPrice, qty) => {
        const oldPrice = oldPriceOrNull ?? new Decimal(0);
        const result = detectPriceChange({ oldUnitPrice: oldPrice, newUnitPrice: newPrice, trailing12moQuantity: qty });
        if (oldPrice.isZero()) {
          expect(result.percentChange).toBeNull();
        } else {
          expect(result.percentChange).not.toBeNull();
        }
      })
    );
  });

  it('an identical old and new price is never significant, regardless of magnitude', () => {
    fc.assert(
      fc.property(positiveCents, quantityValue, (price, qty) => {
        const result = detectPriceChange({ oldUnitPrice: price, newUnitPrice: price, trailing12moQuantity: qty });
        expect(result.isSignificantChange).toBe(false);
        expect(result.priceDelta.isZero()).toBe(true);
      })
    );
  });

  it('DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT is a real, cited constant, not accidentally mutated by any test', () => {
    fc.assert(
      fc.property(positiveCents, positiveCents, quantityValue, (oldPrice, newPrice, qty) => {
        detectPriceChange({ oldUnitPrice: oldPrice, newUnitPrice: newPrice, trailing12moQuantity: qty });
        expect(DEFAULT_PRICE_CHANGE_THRESHOLD_PERCENT.toNumber()).toBe(0.02);
      })
    );
  });
});
