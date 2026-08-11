import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { quantity } from '../primitives/quantity';
import { money } from '../primitives/money';
import { suggestReorder, roundUpToPackSize, enforceMoq, type ConsumptionDay, type ReorderInput } from './reorder';

// Bounded, matching NUMERIC(19,6)-realistic quantities — same convention as fefo.property.test.ts.
const positiveAmount = fc.integer({ min: 1, max: 1_000_000 }).map((micro) => micro / 1000);
const nonNegativeAmount = fc.integer({ min: 0, max: 1_000_000 }).map((micro) => micro / 1000);
const positivePrice = fc.integer({ min: 1, max: 100_000 }).map((cents) => cents / 100);

const BASE_DATE = new Date('2026-01-01T00:00:00Z');
const daysAfterBase = (days: number): Date => new Date(BASE_DATE.getTime() + days * 24 * 60 * 60 * 1000);

const arbConsumptionDay = (dayOffset: number) =>
  fc.record({
    quantityConsumed: fc.option(positiveAmount, { nil: null }),
    isClosureDay: fc.boolean(),
  }).map(
    (r): ConsumptionDay => ({
      date: daysAfterBase(dayOffset),
      quantityConsumed: r.isClosureDay || r.quantityConsumed === null ? null : quantity(r.quantityConsumed, 'kg'),
      isClosureDay: r.isClosureDay,
    })
  );

const arbConsumptionHistory = fc
  .array(fc.integer({ min: 0, max: 60 }), { minLength: 5, maxLength: 30 })
  .chain((offsets) => fc.tuple(...offsets.map((_, i) => arbConsumptionDay(i))));

const arbReorderInput: fc.Arbitrary<ReorderInput> = fc.record({
  stockOnHandAmount: nonNegativeAmount,
  onOrderAmount: nonNegativeAmount,
  consumptionHistory: arbConsumptionHistory,
  leadTimeDays: fc.integer({ min: 1, max: 30 }),
  packSizeAmount: fc.option(positiveAmount, { nil: null }),
  minOrderValueAmount: fc.option(positivePrice, { nil: null }),
  unitPriceAmount: fc.option(positivePrice, { nil: null }),
  coverageDays: fc.integer({ min: 1, max: 30 }),
}).map(
  (r): ReorderInput => ({
    stockOnHand: quantity(r.stockOnHandAmount, 'kg'),
    onOrder: quantity(r.onOrderAmount, 'kg'),
    consumptionHistory: r.consumptionHistory,
    supplier: {
      measuredLeadTimeDays: r.leadTimeDays,
      contractedLeadTimeDays: r.leadTimeDays,
      minOrderValue: r.minOrderValueAmount === null ? null : money(r.minOrderValueAmount, 'USD'),
    },
    supplierProduct: {
      packSize: r.packSizeAmount === null ? null : quantity(r.packSizeAmount, 'kg'),
    },
    unitPrice: r.unitPriceAmount === null ? null : money(r.unitPriceAmount, 'USD'),
    coverageDays: new Decimal(r.coverageDays),
  })
);

describe('suggestReorder — suggested quantity is always a multiple of pack size (mandatory property test)', () => {
  it('never returns a quantity that is not an exact multiple of the configured pack size', () => {
    fc.assert(
      fc.property(arbReorderInput, (input) => {
        const result = suggestReorder(input);
        if (result === null) return;
        if (input.supplierProduct.packSize === null) return;

        const packs = result.quantity.amount.div(input.supplierProduct.packSize.amount);
        expect(packs.isInteger()).toBe(true);
      })
    );
  });
});

describe('suggestReorder — never proposed when projected stock already covers reorder point (mandatory property test)', () => {
  it('stock on hand at 1000x the highest single-day consumption never triggers a suggestion', () => {
    fc.assert(
      fc.property(arbReorderInput, (input) => {
        const measuredDays = input.consumptionHistory.filter((d) => !d.isClosureDay && d.quantityConsumed !== null);
        if (measuredDays.length === 0) return; // covered by the dedicated zero-history test below

        const maxDaily = measuredDays.reduce(
          (max, d) => Decimal.max(max, d.quantityConsumed!.amount),
          new Decimal(0)
        );
        if (maxDaily.lessThanOrEqualTo(0)) return;

        const overstocked = { ...input, stockOnHand: quantity(maxDaily.times(1000), 'kg') };
        expect(suggestReorder(overstocked)).toBeNull();
      })
    );
  });

  it('a suggestion is never returned when onOrder alone already exceeds coverageDays worth of the highest observed daily consumption', () => {
    fc.assert(
      fc.property(arbReorderInput, (input) => {
        const measuredDays = input.consumptionHistory.filter((d) => !d.isClosureDay && d.quantityConsumed !== null);
        if (measuredDays.length === 0) return;

        const maxDaily = measuredDays.reduce(
          (max, d) => Decimal.max(max, d.quantityConsumed!.amount),
          new Decimal(0)
        );
        if (maxDaily.lessThanOrEqualTo(0)) return;

        const overOrdered = { ...input, stockOnHand: quantity(0, 'kg'), onOrder: quantity(maxDaily.times(1000), 'kg') };
        expect(suggestReorder(overOrdered)).toBeNull();
      })
    );
  });
});

describe('suggestReorder — zero/no consumption history never guesses (mandatory property test, I7)', () => {
  it('returns null, never a fabricated quantity, when every day is a closure or unmeasured', () => {
    fc.assert(
      fc.property(arbReorderInput, (input) => {
        const allUnmeasured = input.consumptionHistory.map((d): ConsumptionDay => ({ ...d, quantityConsumed: null, isClosureDay: true }));
        const result = suggestReorder({ ...input, consumptionHistory: allUnmeasured });
        expect(result).toBeNull();
      })
    );
  });

  it('returns null for a genuinely empty consumption history', () => {
    const result = suggestReorder({
      stockOnHand: quantity(1, 'kg'),
      onOrder: quantity(0, 'kg'),
      consumptionHistory: [],
      supplier: { measuredLeadTimeDays: 2, contractedLeadTimeDays: 2, minOrderValue: null },
      supplierProduct: { packSize: null },
      unitPrice: null,
      coverageDays: 10,
    });
    expect(result).toBeNull();
  });
});

describe('suggestReorder — higher consumption variability produces a larger (never smaller) safety stock (mandatory property test)', () => {
  it('a more erratic consumption history never produces a smaller safety-stock-driven suggestion than a steady one at the same mean', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), fc.integer({ min: 1, max: 30 }), (meanAmount, leadTimeDays) => {
        const steadyHistory: ConsumptionDay[] = Array.from({ length: 20 }, (_, i) => ({
          date: daysAfterBase(i),
          quantityConsumed: quantity(meanAmount, 'kg'),
          isClosureDay: false,
        }));

        // Same total (and roughly same trimmed mean) but alternating high/low — genuinely more
        // variable while keeping the mean close to the steady case.
        const erraticHistory: ConsumptionDay[] = Array.from({ length: 20 }, (_, i) => ({
          date: daysAfterBase(i),
          quantityConsumed: quantity(i % 2 === 0 ? meanAmount * 2 : Math.max(meanAmount - meanAmount, 0.001), 'kg'),
          isClosureDay: false,
        }));

        const baseInput = {
          stockOnHand: quantity(0, 'kg'),
          onOrder: quantity(0, 'kg'),
          supplier: { measuredLeadTimeDays: leadTimeDays, contractedLeadTimeDays: leadTimeDays, minOrderValue: null },
          supplierProduct: { packSize: null },
          unitPrice: null,
          coverageDays: new Decimal(leadTimeDays).plus(5),
        };

        const steadyResult = suggestReorder({ ...baseInput, consumptionHistory: steadyHistory });
        const erraticResult = suggestReorder({ ...baseInput, consumptionHistory: erraticHistory });

        // Both should fire (zero stock always triggers reorder with positive consumption).
        if (steadyResult === null || erraticResult === null) return;

        // Erratic demand needs a safety stock at least as large — reflected in the explanation's
        // own reported dailyConsumption*coverageDays+safetyStock derived quantity, which is exactly
        // `result.quantity` before pack/MOQ rounding when both are unset (as here).
        expect(erraticResult.quantity.amount.greaterThanOrEqualTo(steadyResult.quantity.amount)).toBe(true);
      })
    );
  });
});

describe('enforceMoq — never reduces below the computed need (mandatory property test)', () => {
  it('the enforced quantity is always >= the quantity passed in', () => {
    fc.assert(
      fc.property(
        positiveAmount,
        fc.option(positivePrice, { nil: null }),
        fc.option(positivePrice, { nil: null }),
        fc.option(positiveAmount, { nil: null }),
        (qtyAmount, minOrderValueAmount, unitPriceAmount, packSizeAmount) => {
          const qty = quantity(qtyAmount, 'kg');
          const result = enforceMoq(
            qty,
            minOrderValueAmount === null ? null : money(minOrderValueAmount, 'USD'),
            unitPriceAmount === null ? null : money(unitPriceAmount, 'USD'),
            packSizeAmount === null ? null : quantity(packSizeAmount, 'kg')
          );
          expect(result.amount.greaterThanOrEqualTo(qty.amount)).toBe(true);
        }
      )
    );
  });
});

describe('roundUpToPackSize — always rounds up to a whole multiple, never down', () => {
  it('the result is always >= the input and an exact multiple of pack size', () => {
    fc.assert(
      fc.property(nonNegativeAmount, positiveAmount, (needed, packSize) => {
        const result = roundUpToPackSize(quantity(needed, 'kg'), quantity(packSize, 'kg'));
        expect(result.amount.greaterThanOrEqualTo(needed)).toBe(true);
        expect(result.amount.div(packSize).isInteger()).toBe(true);
      })
    );
  });
});
