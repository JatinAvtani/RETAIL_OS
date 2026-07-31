import { Decimal } from 'decimal.js';
import type { CurrencyCode } from './currency.js';

declare const moneyBrand: unique symbol;

/**
 * Branded so `const m: Money = 5` and `const m: Money = new Decimal(5)` are both compile
 * errors — Money can only be constructed via `money()`. Carries its currency so
 * `addMoney(usd, eur)` is a compile error, not a silent wrong-currency sum.
 */
export type Money = {
  readonly [moneyBrand]: 'Money';
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
};

export const money = (value: string | number | Decimal, currency: CurrencyCode): Money => {
  const amount = value instanceof Decimal ? value : new Decimal(value);
  return { amount, currency } as Money;
};

export const isMoney = (value: unknown): value is Money =>
  typeof value === 'object' &&
  value !== null &&
  'amount' in value &&
  'currency' in value &&
  (value as { amount: unknown }).amount instanceof Decimal;

const assertSameCurrency = (a: Money, b: Money): void => {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
};

export const addMoney = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amount.plus(b.amount), a.currency);
};

export const subtractMoney = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amount.minus(b.amount), a.currency);
};

/** Scaling by a plain factor (e.g. quantity) is allowed — the result stays in the same currency. */
export const scaleMoney = (a: Money, factor: string | number | Decimal): Money => {
  const f = factor instanceof Decimal ? factor : new Decimal(factor);
  return money(a.amount.times(f), a.currency);
};

export const compareMoney = (a: Money, b: Money): -1 | 0 | 1 => {
  assertSameCurrency(a, b);
  return a.amount.comparedTo(b.amount) as -1 | 0 | 1;
};

export const zeroMoney = (currency: CurrencyCode): Money => money(0, currency);

export const formatMoney = (m: Money): string => `${m.currency} ${m.amount.toFixed(2)}`;
