import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { quantity } from '../primitives/quantity';
import { money } from '../primitives/money';
import { allocateFefo, type Lot } from './fefo';

// Bounded, matching NUMERIC(19,6)-realistic quantities — same reasoning as every other property
// test file in this project: an unbounded generator produces values no finite-precision decimal
// arithmetic can meaningfully round-trip.
const positiveAmount = fc.integer({ min: 1, max: 1_000_000_000 }).map((micro) => micro / 1_000_000);
const positiveCost = fc.integer({ min: 1, max: 1_000_000 }).map((micro) => micro / 100);

const BASE_DATE = new Date('2026-01-01T00:00:00Z');
const daysAfterBase = (days: number): Date => new Date(BASE_DATE.getTime() + days * 24 * 60 * 60 * 1000);

const arbLot = (id: number) =>
  fc.record({
    lotId: fc.constant(`lot-${id}`),
    remainingQty: positiveAmount,
    unitCost: positiveCost,
    expiryOffsetDays: fc.option(fc.integer({ min: 1, max: 3650 }), { nil: null }),
    receivedOffsetDays: fc.integer({ min: 0, max: 3650 }),
  });

const toLot = (r: {
  lotId: string;
  remainingQty: number;
  unitCost: number;
  expiryOffsetDays: number | null;
  receivedOffsetDays: number;
}): Lot => ({
  lotId: r.lotId,
  remainingQuantity: quantity(r.remainingQty, 'kg'),
  unitCost: money(r.unitCost, 'USD'),
  expiryDate: r.expiryOffsetDays === null ? null : daysAfterBase(r.expiryOffsetDays),
  receivedAt: daysAfterBase(r.receivedOffsetDays),
});

// A handful of lots (2-6), each with independent remaining/cost/expiry/received values.
const arbLots = fc
  .array(fc.integer({ min: 0, max: 5 }), { minLength: 2, maxLength: 6 })
  .chain((ids) => fc.tuple(...ids.map((_, i) => arbLot(i))))
  .map((records) => records.map(toLot));

describe('allocateFefo — never over-allocates a lot (mandatory property test)', () => {
  it('no lot is ever allocated more than its own remainingQuantity', () => {
    fc.assert(
      fc.property(arbLots, positiveAmount, (lots, requiredAmount) => {
        const result = allocateFefo(lots, quantity(requiredAmount, 'kg'));

        for (const lot of lots) {
          const taken = result.allocations
            .filter((a) => a.lotId === lot.lotId)
            .reduce((sum, a) => sum.plus(a.quantity.amount), new Decimal(0));
          expect(taken.lessThanOrEqualTo(lot.remainingQuantity.amount)).toBe(true);
        }
      })
    );
  });
});

describe('allocateFefo — allocation + shortfall equals requested (mandatory property test)', () => {
  it('the sum of all allocations plus any shortfall exactly equals the required quantity', () => {
    fc.assert(
      fc.property(arbLots, positiveAmount, (lots, requiredAmount) => {
        const required = quantity(requiredAmount, 'kg');
        const result = allocateFefo(lots, required);

        const allocatedTotal = result.allocations.reduce(
          (sum, a) => sum.plus(a.quantity.amount),
          new Decimal(0)
        );
        const total = allocatedTotal.plus(result.shortfall?.amount ?? 0);
        expect(total.toString()).toBe(required.amount.toString());
      })
    );
  });

  it('a shortfall is only ever reported when the lots genuinely cannot cover the requirement', () => {
    fc.assert(
      fc.property(arbLots, positiveAmount, (lots, requiredAmount) => {
        const required = quantity(requiredAmount, 'kg');
        const result = allocateFefo(lots, required);
        const totalAvailable = lots.reduce((sum, l) => sum.plus(l.remainingQuantity.amount), new Decimal(0));

        if (totalAvailable.greaterThanOrEqualTo(required.amount)) {
          expect(result.shortfall).toBeNull();
        } else {
          expect(result.shortfall).not.toBeNull();
        }
      })
    );
  });
});

describe('allocateFefo — FEFO order respected (mandatory property test)', () => {
  it('no lot is drawn from while an earlier-expiring lot (with stock) is skipped', () => {
    fc.assert(
      fc.property(arbLots, positiveAmount, (lots, requiredAmount) => {
        const result = allocateFefo(lots, quantity(requiredAmount, 'kg'));
        const allocatedIds = new Set(result.allocations.map((a) => a.lotId));

        // rank = expiry date (nulls sort last), tie-broken by receivedAt — the same order
        // allocateFefo itself is supposed to draw in.
        const rank = (lot: Lot): [number, number] => [
          lot.expiryDate === null ? Number.POSITIVE_INFINITY : lot.expiryDate.getTime(),
          lot.receivedAt.getTime(),
        ];

        for (const later of lots) {
          if (!allocatedIds.has(later.lotId)) continue;
          for (const earlier of lots) {
            if (earlier.lotId === later.lotId) continue;
            const earlierRank = rank(earlier);
            const laterRank = rank(later);
            const earlierIsStrictlyBefore =
              earlierRank[0] < laterRank[0] || (earlierRank[0] === laterRank[0] && earlierRank[1] < laterRank[1]);

            if (earlierIsStrictlyBefore) {
              // If an earlier-ranked lot had stock, it must have been fully drawn (allocated in
              // full, or drawn down to exactly the amount `allocateFefo` chose) before `later`
              // was touched at all — i.e. it cannot still show untouched remaining stock while a
              // later-ranked lot was allocated from.
              const earlierAllocated = result.allocations
                .filter((a) => a.lotId === earlier.lotId)
                .reduce((sum, a) => sum.plus(a.quantity.amount), new Decimal(0));
              const earlierFullyTaken = earlierAllocated.greaterThanOrEqualTo(earlier.remainingQuantity.amount);
              expect(earlierFullyTaken).toBe(true);
            }
          }
        }
      })
    );
  });

  it('FIFO policy ignores expiry and orders strictly by receivedAt', () => {
    const lots: Lot[] = [
      { lotId: 'a', remainingQuantity: quantity(5, 'kg'), unitCost: money(1, 'USD'), expiryDate: daysAfterBase(100), receivedAt: daysAfterBase(2) },
      { lotId: 'b', remainingQuantity: quantity(5, 'kg'), unitCost: money(1, 'USD'), expiryDate: daysAfterBase(1), receivedAt: daysAfterBase(1) },
    ];
    const result = allocateFefo(lots, quantity(5, 'kg'), 'FIFO');
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.lotId).toBe('b');
  });

  it('concrete anchor: draws the earlier-expiring lot first even though it was received later', () => {
    const lots: Lot[] = [
      { lotId: 'later-expiry', remainingQuantity: quantity(10, 'kg'), unitCost: money(2, 'USD'), expiryDate: daysAfterBase(30), receivedAt: daysAfterBase(1) },
      { lotId: 'earlier-expiry', remainingQuantity: quantity(10, 'kg'), unitCost: money(3, 'USD'), expiryDate: daysAfterBase(10), receivedAt: daysAfterBase(5) },
    ];
    const result = allocateFefo(lots, quantity(10, 'kg'));
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.lotId).toBe('earlier-expiry');
  });

  it('no-expiry lots are drawn from only after every dated lot is exhausted', () => {
    const lots: Lot[] = [
      { lotId: 'no-expiry', remainingQuantity: quantity(5, 'kg'), unitCost: money(1, 'USD'), expiryDate: null, receivedAt: daysAfterBase(1) },
      { lotId: 'dated', remainingQuantity: quantity(5, 'kg'), unitCost: money(1, 'USD'), expiryDate: daysAfterBase(10), receivedAt: daysAfterBase(2) },
    ];
    const result = allocateFefo(lots, quantity(6, 'kg'));
    expect(result.allocations[0]?.lotId).toBe('dated');
    expect(result.allocations[1]?.lotId).toBe('no-expiry');
  });
});

describe('allocateFefo — unknown cost propagates as null, never zero (I7, mandatory property test)', () => {
  it('totalCost is null whenever any allocated lot has an unknown unit cost', () => {
    fc.assert(
      fc.property(arbLots, positiveAmount, fc.integer({ min: 0, max: 5 }), (lots, requiredAmount, unknownIndex) => {
        const lotsWithOneUnknown = lots.map((lot, i) => (i === unknownIndex % lots.length ? { ...lot, unitCost: null } : lot));
        const result = allocateFefo(lotsWithOneUnknown, quantity(requiredAmount, 'kg'));

        const targetLotId = lotsWithOneUnknown[unknownIndex % lots.length]!.lotId;
        const targetWasAllocated = result.allocations.some((a) => a.lotId === targetLotId);

        if (targetWasAllocated) {
          expect(result.totalCost).toBeNull();
        }
      })
    );
  });

  it('concrete anchor: totalCost is the exact sum of quantity * unitCost when every allocated lot has a known cost', () => {
    const lots: Lot[] = [
      { lotId: 'a', remainingQuantity: quantity(3, 'kg'), unitCost: money('2.50', 'USD'), expiryDate: daysAfterBase(1), receivedAt: daysAfterBase(1) },
      { lotId: 'b', remainingQuantity: quantity(3, 'kg'), unitCost: money('4.00', 'USD'), expiryDate: daysAfterBase(2), receivedAt: daysAfterBase(2) },
    ];
    // 3kg from lot a (2.50 * 3 = 7.50) + 2kg from lot b (4.00 * 2 = 8.00) = 15.50
    const result = allocateFefo(lots, quantity(5, 'kg'));
    expect(result.totalCost?.amount.toString()).toBe('15.5');
  });

  it('totalCost is null (never zero or a guessed value) when nothing could be allocated at all', () => {
    const result = allocateFefo([], quantity(5, 'kg'));
    expect(result.totalCost).toBeNull();
    expect(result.shortfall?.amount.toString()).toBe('5');
  });
});

describe('allocateFefo — unit safety (I6)', () => {
  it('throws rather than silently mixing units when a lot is in a different unit than required', () => {
    const lots: Lot[] = [
      { lotId: 'a', remainingQuantity: quantity(5, 'g'), unitCost: money(1, 'USD'), expiryDate: null, receivedAt: daysAfterBase(1) },
    ];
    expect(() => allocateFefo(lots, quantity(5, 'kg'))).toThrow(/unit/);
  });
});
