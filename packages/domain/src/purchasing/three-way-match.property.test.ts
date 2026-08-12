import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { classifyLineMatch, DEFAULT_MATCH_TOLERANCES } from './three-way-match';

const positiveCents = fc.integer({ min: 1, max: 1_000_000 }).map((c) => new Decimal(c).dividedBy(100));
const quantityValue = fc.integer({ min: 1, max: 10_000 }).map((q) => new Decimal(q).dividedBy(100));

describe('classifyLineMatch — property tests', () => {
  it('an exact price and quantity match is always CLEAN, regardless of magnitude', () => {
    fc.assert(
      fc.property(quantityValue, positiveCents, (qty, price) => {
        const result = classifyLineMatch({ quantity: qty, unitPrice: price }, { poUnitPrice: price, receivedQuantity: qty, receiptFound: true });
        expect(result.varianceType).toBe('CLEAN');
        expect(result.varianceSeverity).toBe('NONE');
      })
    );
  });

  it('a price variance strictly beyond BOTH tolerances is never classified CLEAN', () => {
    fc.assert(
      fc.property(quantityValue, positiveCents, positiveCents, (qty, poPrice, delta) => {
        // Force a delta guaranteed to exceed both the $5 absolute AND 2% relative tolerance.
        const guaranteedExcess = Decimal.max(delta, DEFAULT_MATCH_TOLERANCES.priceToleranceAbsolute.plus(1), poPrice.times('0.5'));
        const invoicePrice = poPrice.plus(guaranteedExcess);
        const result = classifyLineMatch({ quantity: qty, unitPrice: invoicePrice }, { poUnitPrice: poPrice, receivedQuantity: qty, receiptFound: true });
        expect(result.varianceType).not.toBe('CLEAN');
        expect(result.varianceSeverity).not.toBe('NONE');
      })
    );
  });

  it('INVOICED_NOT_RECEIVED is always HIGH severity, regardless of amounts — the fraud-flag priority is never diluted', () => {
    fc.assert(
      fc.property(quantityValue, positiveCents, (qty, price) => {
        const result = classifyLineMatch({ quantity: qty, unitPrice: price }, { poUnitPrice: price, receivedQuantity: null, receiptFound: false });
        expect(result.varianceType).toBe('INVOICED_NOT_RECEIVED');
        expect(result.varianceSeverity).toBe('HIGH');
      })
    );
  });

  it('a null quantity or unitPrice never produces a numeric priceVariance/quantityVariance — I7, never a guessed number from missing data', () => {
    fc.assert(
      fc.property(fc.option(quantityValue, { nil: null }), fc.option(positiveCents, { nil: null }), (qty, price) => {
        fc.pre(qty === null || price === null);
        const result = classifyLineMatch({ quantity: qty, unitPrice: price }, { poUnitPrice: null, receivedQuantity: null, receiptFound: false });
        expect(result.priceVariance).toBeNull();
        expect(result.quantityVariance).toBeNull();
        expect(result.varianceType).toBe('UNORDERED_ITEM');
      })
    );
  });
});
