import { Decimal } from 'decimal.js';
import type { Unit } from './unit.js';
import { globalConversionFactor } from './unit.js';
import type { Quantity } from './quantity.js';
import { quantity } from './quantity.js';

/**
 * The stored side of the conversion graph (packages/db's unit_conversions table, the design),
 * projected into the shape this pure function needs. Deliberately just unit ids + a factor + an
 * optional product id — no I/O, no knowledge of Drizzle or Postgres, so this stays testable
 * without a database (per CLAUDE.md: domain logic is pure functions).
 */
export type ConversionFactorRow = {
  fromUnitId: string;
  toUnitId: string;
  productId: string | null;
  factor: string | number | Decimal;
};

/** Everything known about conversions for one organization, handed to `resolveConversion` at once. */
export type ConversionTable = ConversionFactorRow[];

export class ConversionNotFoundError extends Error {
  constructor(
    public readonly fromUnitId: string,
    public readonly toUnitId: string,
    public readonly productId?: string
  ) {
    super(
      `No conversion from unit '${fromUnitId}' to '${toUnitId}'` +
        (productId ? ` for product '${productId}'` : '') +
        ' — neither a product-specific nor a global conversion is defined. Refusing to guess (I7).'
    );
    this.name = 'ConversionNotFoundError';
  }
}

/**
 * Resolution order per the design / a later milestone the plan: product-specific row first, then the
 * global (productId === null) row, then fail loudly. This is the ONE place in the codebase that
 * decides which factor wins when both exist — callers never inline that priority themselves,
 * which is exactly how a silent "which row did we actually use" bug would happen (I6).
 */
export const resolveConversionFactor = (
  table: ConversionTable,
  fromUnitId: string,
  toUnitId: string,
  productId?: string
): Decimal => {
  if (productId) {
    const specific = table.find(
      (row) => row.fromUnitId === fromUnitId && row.toUnitId === toUnitId && row.productId === productId
    );
    if (specific) return new Decimal(specific.factor);
  }

  const global = table.find(
    (row) => row.fromUnitId === fromUnitId && row.toUnitId === toUnitId && row.productId === null
  );
  if (global) return new Decimal(global.factor);

  throw new ConversionNotFoundError(fromUnitId, toUnitId, productId);
};

/**
 * The one boundary-crossing conversion function that knows about product-specific overrides, on
 * top of `convertQuantity`'s global-only mass/volume math. Still a single, explicit call — never
 * chained or applied implicitly mid-calculation (I6). Falls through to `convertQuantity`'s global
 * table first (same-unit identity and dimension-internal conversions like kg<->g), and only
 * consults `table` when that fails, so a global conversion never needs a redundant row in the
 * stored table just to be found.
 *
 * `fromUnitId`/`toUnitId` are the *stored* unit identities (packages/db's units.id), not the
 * `Unit` string codes `Quantity` is branded with — a caller resolving a real product's conversion
 * has both available (the unit code from `Quantity.unit`, the id from a `UnitRepository` lookup),
 * and passing the wrong one is a type error, not a runtime surprise, since they're different
 * parameter types.
 */
export const resolveQuantity = <From extends Unit, To extends Unit>(
  qty: Quantity<From>,
  toUnit: To,
  fromUnitId: string,
  toUnitId: string,
  table: ConversionTable,
  productId?: string
): Quantity<To> => {
  if ((qty.unit as Unit) === (toUnit as Unit)) {
    return quantity(qty.amount, toUnit);
  }

  const global = globalConversionFactor(qty.unit, toUnit);
  if (global !== null) {
    return quantity(qty.amount.times(global), toUnit);
  }

  const factor = resolveConversionFactor(table, fromUnitId, toUnitId, productId);
  return quantity(qty.amount.times(factor), toUnit);
};
