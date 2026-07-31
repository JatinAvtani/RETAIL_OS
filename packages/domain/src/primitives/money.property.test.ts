import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { addMoney, money, subtractMoney, type Money } from './money';
import type { CurrencyCode } from './currency';

/**
 * Property-based tests (plan.md Phase 7): "write one trivial property test now to prove the
 * harness works, so that when real domain logic arrives the tooling isn't also unproven." These
 * go further than trivial, since Money/Quantity (001-05) are real, load-bearing domain code, not
 * placeholders — an under-tested branded-arithmetic layer would be exactly the kind of thing I7's
 * warning about silent precision loss is written for.
 */
const currency = fc.constantFrom<CurrencyCode>('USD', 'EUR', 'GBP', 'INR');

// Bounded to two decimal places within a realistic monetary range (matching Postgres's
// NUMERIC(19,4) column width, spec 08 SS8.2) via integer cents, not fc.double() directly.
// fc.double()'s full range includes values like 5e-324 alongside 1e-304 - real Decimal
// arithmetic at any finite precision cannot represent both a number and one ~280 orders of
// magnitude larger simultaneously, so adding and subtracting such a pair loses the tiny one
// entirely. That's an inherent property of finite-precision decimal math, not a bug in
// addMoney/subtractMoney, and it isn't a value any real Money will ever hold - so the generator
// is scoped to what Money is actually for, not "everything an IEEE double can represent."
const moneyAmount = fc
  .integer({ min: -100_000_000_000, max: 100_000_000_000 })
  .map((cents) => cents / 100);

const arbitraryMoney = (): fc.Arbitrary<Money> =>
  fc.tuple(moneyAmount, currency).map(([amount, cur]) => money(amount, cur));

describe('Money arithmetic properties', () => {
  it('addMoney then subtractMoney returns the original amount (inverse property)', () => {
    fc.assert(
      fc.property(arbitraryMoney(), arbitraryMoney(), (a, b) => {
        // b must share a's currency for addMoney/subtractMoney to accept it.
        const bSameCurrency = money(b.amount, a.currency);
        const result = subtractMoney(addMoney(a, bSameCurrency), bSameCurrency);
        expect(result.amount.toString()).toBe(a.amount.toString());
        expect(result.currency).toBe(a.currency);
      })
    );
  });

  it('addMoney is commutative for same-currency amounts', () => {
    fc.assert(
      fc.property(arbitraryMoney(), moneyAmount, (a, bAmount) => {
        const b = money(bAmount, a.currency);
        expect(addMoney(a, b).amount.toString()).toBe(addMoney(b, a).amount.toString());
      })
    );
  });

  it('addMoney across different currencies always throws — never silently sums (I5)', () => {
    fc.assert(
      fc.property(arbitraryMoney(), arbitraryMoney(), (a, b) => {
        fc.pre(a.currency !== b.currency);
        expect(() => addMoney(a, b)).toThrow(/Currency mismatch/);
      })
    );
  });

  it('addMoney never loses precision that plain floating-point addition would', () => {
    // The concrete failure mode this guards against: 0.1 + 0.2 !== 0.3 in IEEE 754 floats.
    // Decimal-backed Money must not inherit that.
    const a = money('0.1', 'USD');
    const b = money('0.2', 'USD');
    expect(addMoney(a, b).amount.equals(new Decimal('0.3'))).toBe(true);
  });
});
