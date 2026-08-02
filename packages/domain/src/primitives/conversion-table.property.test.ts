import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { quantity } from './quantity';
import {
  ConversionNotFoundError,
  resolveConversionFactor,
  resolveQuantity,
  type ConversionTable,
} from './conversion-table';

const KG_ID = 'unit-kg';
const G_ID = 'unit-g';
const CASE_ID = 'unit-case';

// Bounded, matching NUMERIC(19,6)-realistic quantities — same reasoning as
// quantity.property.test.ts: an unbounded fc.double() range produces values no finite-precision
// decimal arithmetic can meaningfully round-trip, which is a generator-range issue, not a bug.
const positiveAmount = fc.integer({ min: 1, max: 1_000_000_000_000 }).map((micro) => micro / 1_000_000);
const positiveFactor = fc.integer({ min: 1, max: 1_000_000_000 }).map((micro) => micro / 1_000);

describe('Conversion resolution order (I6)', () => {
  it('prefers the product-specific row over the global row for the same unit pair', () => {
    fc.assert(
      fc.property(positiveFactor, positiveFactor, fc.uuid(), (globalFactor, specificFactor, productId) => {
        fc.pre(globalFactor !== specificFactor);
        const table: ConversionTable = [
          { fromUnitId: CASE_ID, toUnitId: KG_ID, productId: null, factor: globalFactor },
          { fromUnitId: CASE_ID, toUnitId: KG_ID, productId, factor: specificFactor },
        ];

        const resolved = resolveConversionFactor(table, CASE_ID, KG_ID, productId);
        expect(resolved.toString()).toBe(specificFactor.toString());
      })
    );
  });

  it('falls back to the global row when no product id is given', () => {
    fc.assert(
      fc.property(positiveFactor, positiveFactor, fc.uuid(), (globalFactor, specificFactor, productId) => {
        const table: ConversionTable = [
          { fromUnitId: CASE_ID, toUnitId: KG_ID, productId: null, factor: globalFactor },
          { fromUnitId: CASE_ID, toUnitId: KG_ID, productId, factor: specificFactor },
        ];

        const resolved = resolveConversionFactor(table, CASE_ID, KG_ID);
        expect(resolved.toString()).toBe(globalFactor.toString());
      })
    );
  });

  it('falls back to the global row when a product-specific row exists for a DIFFERENT product', () => {
    fc.assert(
      fc.property(
        positiveFactor,
        positiveFactor,
        fc.uuid(),
        fc.uuid(),
        (globalFactor, otherFactor, ownerProductId, queriedProductId) => {
          fc.pre(ownerProductId !== queriedProductId);
          const table: ConversionTable = [
            { fromUnitId: CASE_ID, toUnitId: KG_ID, productId: null, factor: globalFactor },
            { fromUnitId: CASE_ID, toUnitId: KG_ID, productId: ownerProductId, factor: otherFactor },
          ];

          const resolved = resolveConversionFactor(table, CASE_ID, KG_ID, queriedProductId);
          expect(resolved.toString()).toBe(globalFactor.toString());
        }
      )
    );
  });

  it('throws (never guesses) when neither a product-specific nor a global row exists', () => {
    fc.assert(
      fc.property(fc.uuid(), (productId) => {
        expect(() => resolveConversionFactor([], CASE_ID, KG_ID, productId)).toThrow(ConversionNotFoundError);
        expect(() => resolveConversionFactor([], CASE_ID, KG_ID)).toThrow(ConversionNotFoundError);
      })
    );
  });

  it('a product-only conversion (no global fallback) is found for its own product and refused for another', () => {
    fc.assert(
      fc.property(positiveFactor, fc.uuid(), fc.uuid(), (factor, ownerProductId, otherProductId) => {
        fc.pre(ownerProductId !== otherProductId);
        const table: ConversionTable = [{ fromUnitId: CASE_ID, toUnitId: KG_ID, productId: ownerProductId, factor }];

        expect(resolveConversionFactor(table, CASE_ID, KG_ID, ownerProductId).toString()).toBe(factor.toString());
        expect(() => resolveConversionFactor(table, CASE_ID, KG_ID, otherProductId)).toThrow(
          ConversionNotFoundError
        );
      })
    );
  });
});

describe('resolveQuantity — product-specific boundary conversion (I6)', () => {
  it('applies a product-specific factor exactly once (case -> kg)', () => {
    fc.assert(
      fc.property(positiveAmount, positiveFactor, fc.uuid(), (amountInCases, kgPerCase, productId) => {
        const table: ConversionTable = [
          { fromUnitId: CASE_ID, toUnitId: KG_ID, productId, factor: kgPerCase },
        ];
        const cases = quantity(amountInCases, 'each'); // 'each' stands in for a countable case unit here.

        const result = resolveQuantity(cases, 'kg', CASE_ID, KG_ID, table, productId);

        const expected = new Decimal(amountInCases).times(kgPerCase);
        expect(result.amount.toString()).toBe(expected.toString());
        expect(result.unit).toBe('kg');
      })
    );
  });

  it('global-dimension conversions (kg -> g) never need a table row', () => {
    fc.assert(
      fc.property(positiveAmount, (amountKg) => {
        const kg = quantity(amountKg, 'kg');
        const result = resolveQuantity(kg, 'g', KG_ID, G_ID, []);
        expect(result.amount.toString()).toBe(new Decimal(amountKg).times(1000).toString());
      })
    );
  });

  it('same-unit resolution is the identity, regardless of table contents', () => {
    fc.assert(
      fc.property(positiveAmount, (amountKg) => {
        const kg = quantity(amountKg, 'kg');
        const result = resolveQuantity(kg, 'kg', KG_ID, KG_ID, []);
        expect(result.amount.toString()).toBe(kg.amount.toString());
      })
    );
  });

  it('chained resolution (case -> kg -> g) equals one direct global conversion after the boundary crossing', () => {
    fc.assert(
      fc.property(positiveAmount, positiveFactor, fc.uuid(), (amountInCases, kgPerCase, productId) => {
        const table: ConversionTable = [
          { fromUnitId: CASE_ID, toUnitId: KG_ID, productId, factor: kgPerCase },
        ];
        const cases = quantity(amountInCases, 'each');

        const viaKg = resolveQuantity(cases, 'kg', CASE_ID, KG_ID, table, productId);
        const chained = resolveQuantity(viaKg, 'g', KG_ID, G_ID, table);

        const expected = new Decimal(amountInCases).times(kgPerCase).times(1000);
        expect(chained.amount.toString()).toBe(expected.toString());
      })
    );
  });

  it('throws instead of silently returning a 1:1 factor when no conversion is defined', () => {
    fc.assert(
      fc.property(positiveAmount, fc.uuid(), (amountInCases, productId) => {
        const cases = quantity(amountInCases, 'each');
        expect(() => resolveQuantity(cases, 'kg', CASE_ID, KG_ID, [], productId)).toThrow(
          ConversionNotFoundError
        );
      })
    );
  });
});
