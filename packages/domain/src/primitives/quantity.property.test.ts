import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addQuantity, convertQuantity, quantity, subtractQuantity } from './quantity';
import type { MassUnit, VolumeUnit } from './unit';

const massUnit = fc.constantFrom<MassUnit>('mg', 'g', 'kg');
const volumeUnit = fc.constantFrom<VolumeUnit>('ml', 'l');

// Bounded to a realistic quantity range (matching NUMERIC(19,6), spec 08 SS8.2) via integer
// micro-units, not fc.double() directly - see money.property.test.ts for why an unbounded
// double generator produces values like 5e-324 that no finite-precision decimal arithmetic can
// round-trip against a value ~280 orders of magnitude larger, which is a property of the
// generator's range, not a bug in addQuantity/subtractQuantity/convertQuantity.
const positiveAmount = fc.integer({ min: 0, max: 1_000_000_000_000 }).map((micro) => micro / 1_000_000);

describe('Quantity unit-conversion properties (I6)', () => {
  it('converting mass to another mass unit and back returns the original amount', () => {
    fc.assert(
      fc.property(positiveAmount, massUnit, massUnit, (amount, fromUnit, toUnit) => {
        const original = quantity(amount, fromUnit);
        const converted = convertQuantity(original, toUnit);
        const roundTripped = convertQuantity(converted, fromUnit);
        // decimal.js exact rational arithmetic on the conversion factors used here (1000/1,
        // 1/1000, 1) round-trips exactly - no epsilon needed, unlike float round-tripping.
        expect(roundTripped.amount.toString()).toBe(original.amount.toString());
      })
    );
  });

  it('converting volume to another volume unit and back returns the original amount', () => {
    fc.assert(
      fc.property(positiveAmount, volumeUnit, volumeUnit, (amount, fromUnit, toUnit) => {
        const original = quantity(amount, fromUnit);
        const roundTripped = convertQuantity(convertQuantity(original, toUnit), fromUnit);
        expect(roundTripped.amount.toString()).toBe(original.amount.toString());
      })
    );
  });

  it('converting mass to a volume unit always throws - no silent cross-dimension conversion', () => {
    fc.assert(
      fc.property(positiveAmount, massUnit, volumeUnit, (amount, fromUnit, toUnit) => {
        expect(() => convertQuantity(quantity(amount, fromUnit), toUnit)).toThrow(
          /No global conversion/
        );
      })
    );
  });

  it('addQuantity then subtractQuantity returns the original amount (inverse property)', () => {
    fc.assert(
      fc.property(positiveAmount, positiveAmount, massUnit, (a, b, unit) => {
        const qa = quantity(a, unit);
        const qb = quantity(b, unit);
        const result = subtractQuantity(addQuantity(qa, qb), qb);
        expect(result.amount.toString()).toBe(qa.amount.toString());
      })
    );
  });

  it('1000 mg converts to exactly 1 g, and 1000 g converts to exactly 1 kg', () => {
    // Concrete example anchoring the property tests above to numbers a reader can check by hand.
    expect(convertQuantity(quantity(1000, 'mg'), 'g').amount.toString()).toBe('1');
    expect(convertQuantity(quantity(1000, 'g'), 'kg').amount.toString()).toBe('1');
  });
});
