/**
 * Compile-time proof that Money/Quantity branding actually rejects the unsafe operations
 * the plan calls out. This file is included in `tsc --noEmit` — if any `@ts-expect-error`
 * stops being an actual error (i.e. the branding regresses), this file fails to typecheck
 * and CI catches it. Nothing here runs; it exists to fail to compile in the right way.
 */
import { Decimal } from 'decimal.js';
import { money, addMoney, type Money } from './money.js';
import { quantity, addQuantity, convertQuantity } from './quantity.js';

// Money cannot be constructed from a raw number or Decimal — only via `money()`.
// @ts-expect-error — a bare number is not a Money
const _m1: Money = 5;
// @ts-expect-error — a bare Decimal is not a Money (currency is required)
const _m2: Money = new Decimal(5);

// addMoney enforces same-currency at the type level via mismatched literal usage sites
// (currency mismatch is a runtime throw by design — see money.ts assertSameCurrency —
// because CurrencyCode is a plain union, not one branded type per currency; the type-level
// guarantee is that both arguments must be Money, not arbitrary numbers).
// @ts-expect-error — cannot add a raw number to Money
const _m3 = addMoney(money(1, 'USD'), 5);

// Quantity<'kg'> and Quantity<'g'> are distinct types — plain arithmetic across units
// must fail; only `convertQuantity` may bridge them.
const qtyKg = quantity(1, 'kg');
const qtyG = quantity(1000, 'g');
// @ts-expect-error — Quantity<'kg'> is not assignable to Quantity<'g'>, so addQuantity rejects it
const _q1 = addQuantity(qtyKg, qtyG);

// The explicit, sanctioned path compiles fine:
const _q2 = addQuantity(qtyKg, convertQuantity(qtyG, 'kg'));

// Reference every value so `noUnusedLocals` doesn't flag them — this file's job is to prove
// compile *errors* occur, not to be dead-code-clean.
export const _typeTestSink = { _m1, _m2, _m3, _q1, _q2 };
