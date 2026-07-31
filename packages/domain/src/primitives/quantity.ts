import { Decimal } from 'decimal.js';
import type { Unit } from './unit.js';
import { globalConversionFactor } from './unit.js';

declare const quantityBrand: unique symbol;

/**
 * Branded per-unit so `qtyKg + qtyG` (plain arithmetic on the wrapped Decimal) is a compile
 * error, and mixing units in one expression must go through `convertQuantity` explicitly (I6).
 * `Quantity<'kg'>` and `Quantity<'g'>` are distinct, incompatible types even though both wrap
 * a Decimal.
 */
export type Quantity<U extends Unit> = {
  readonly [quantityBrand]: 'Quantity';
  readonly amount: Decimal;
  readonly unit: U;
};

export const quantity = <U extends Unit>(value: string | number | Decimal, unit: U): Quantity<U> => {
  const amount = value instanceof Decimal ? value : new Decimal(value);
  return { amount, unit } as Quantity<U>;
};

export const isQuantity = (value: unknown): value is Quantity<Unit> =>
  typeof value === 'object' &&
  value !== null &&
  'amount' in value &&
  'unit' in value &&
  (value as { amount: unknown }).amount instanceof Decimal;

/**
 * `b`'s type is pinned to `a`'s concrete unit via a non-generic second parameter position
 * (`Quantity<U>` where `U` is inferred from `a` only, then `b` is checked against it). A naive
 * `<U extends Unit>(a: Quantity<U>, b: Quantity<U>)` signature lets TS unify `U` to a *union*
 * of both units instead of rejecting the mismatch — `addQuantity(qtyKg, qtyG)` would silently
 * compile with `U = 'kg' | 'g'`. Forcing inference from `a` alone closes that hole.
 */
export const addQuantity = <U extends Unit>(a: Quantity<U>, b: Quantity<NoInfer<U>>): Quantity<U> =>
  quantity(a.amount.plus(b.amount), a.unit);

export const subtractQuantity = <U extends Unit>(a: Quantity<U>, b: Quantity<NoInfer<U>>): Quantity<U> =>
  quantity(a.amount.minus(b.amount), a.unit);

export const scaleQuantity = <U extends Unit>(a: Quantity<U>, factor: string | number | Decimal): Quantity<U> => {
  const f = factor instanceof Decimal ? factor : new Decimal(factor);
  return quantity(a.amount.times(f), a.unit);
};

export const compareQuantity = <U extends Unit>(a: Quantity<U>, b: Quantity<NoInfer<U>>): -1 | 0 | 1 =>
  a.amount.comparedTo(b.amount) as -1 | 0 | 1;

/**
 * Explicit, global (dimension-internal) unit conversion — e.g. kg <-> g, l <-> ml.
 * This is the ONLY sanctioned way to move a quantity between units (I6): it is a boundary
 * operation, called once, never implicit mid-calculation. Throws for cross-dimension or
 * product-specific conversions (e.g. "case" sizing), which must go through the product's own
 * conversion table (UnitOfMeasure / UnitConversion, spec 07 §7.3) — never this global helper.
 */
export const convertQuantity = <From extends Unit, To extends Unit>(
  q: Quantity<From>,
  toUnit: To
): Quantity<To> => {
  if ((q.unit as Unit) === (toUnit as Unit)) {
    return quantity(q.amount, toUnit);
  }

  const factor = globalConversionFactor(q.unit, toUnit);
  if (factor === null) {
    throw new Error(
      `No global conversion from '${q.unit}' to '${toUnit}' — this requires a product-specific conversion.`
    );
  }

  return quantity(q.amount.times(factor), toUnit);
};

export const zeroQuantity = <U extends Unit>(unit: U): Quantity<U> => quantity(0, unit);
