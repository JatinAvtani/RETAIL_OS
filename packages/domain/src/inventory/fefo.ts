import { Decimal } from 'decimal.js';
import type { Unit } from '../primitives/unit.js';
import type { Quantity } from '../primitives/quantity.js';
import { quantity } from '../primitives/quantity.js';
import type { Money } from '../primitives/money.js';
import { zeroMoney, addMoney, scaleMoney } from '../primitives/money.js';

/**
 * The slice of a lot FEFO allocation needs — deliberately not the full DB row (no supplier,
 * source document, etc.), so this stays testable without a database, per CLAUDE.md's domain-logic
 * discipline. `unitCost: null` models a lot whose cost is genuinely unknown (e.g. a receipt still
 * pending price confirmation) — never a `0` standing in for "unknown" (I7).
 */
export type Lot = {
  lotId: string;
  remainingQuantity: Quantity<Unit>;
  unitCost: Money | null;
  expiryDate: Date | null;
  receivedAt: Date;
};

export type LotAllocation = {
  lotId: string;
  quantity: Quantity<Unit>;
  unitCost: Money | null;
};

export type AllocationResult = {
  allocations: LotAllocation[];
  /** Unmet portion of `required`, or `null` if fully allocated. Negative stock is a signal, not an error — the caller decides what to do with a shortfall, never this function. */
  shortfall: Quantity<Unit> | null;
  /** `null` if allocations is empty OR any allocated lot has `unitCost: null` — a partial sum would silently understate true cost (I7). */
  totalCost: Money | null;
};

/**
 * Orders lots the way FEFO (or FIFO) requires: earliest-expiring first, nulls (no tracked expiry)
 * last — an item with no dated expiry should only be drawn from once every dated lot is exhausted.
 * FIFO ignores expiry entirely and orders by receipt date alone.
 */
const sortForAllocation = (lots: readonly Lot[], policy: 'FEFO' | 'FIFO'): Lot[] =>
  [...lots].sort((a, b) => {
    if (policy === 'FEFO') {
      if (a.expiryDate === null && b.expiryDate === null) {
        return a.receivedAt.getTime() - b.receivedAt.getTime();
      }
      if (a.expiryDate === null) return 1;
      if (b.expiryDate === null) return -1;
      const byExpiry = a.expiryDate.getTime() - b.expiryDate.getTime();
      if (byExpiry !== 0) return byExpiry;
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    }
    return a.receivedAt.getTime() - b.receivedAt.getTime();
  });

/**
 * Greedily allocates `required` across `lots` in FEFO (default) or FIFO order, never drawing more
 * than a lot's own `remainingQuantity` (property-tested). Lots already at or below zero remaining,
 * or past `asOf`'s notion of "now" in a way the caller has already filtered (this function trusts
 * the input list — it does not re-check status/expiry against `asOf` itself, since that's a query
 * concern, not an allocation-order concern), are simply skipped once exhausted.
 *
 * Running out of lots before `required` is met produces a `shortfall`, never an exception —
 * negative stock is a signal (a receipt wasn't recorded), not a hard error, per plan.md.
 */
export const allocateFefo = (
  lots: readonly Lot[],
  required: Quantity<Unit>,
  policy: 'FEFO' | 'FIFO' = 'FEFO'
): AllocationResult => {
  const ordered = sortForAllocation(lots, policy);
  const allocations: LotAllocation[] = [];
  let remaining = required.amount;
  let anyUnknownCost = false;

  for (const lot of ordered) {
    if (remaining.lessThanOrEqualTo(0)) break;
    if (lot.remainingQuantity.unit !== required.unit) {
      throw new Error(
        `allocateFefo requires every lot's remainingQuantity to already be in the requested unit ('${required.unit}'), got '${lot.remainingQuantity.unit}' for lot '${lot.lotId}' — convert at the boundary before calling, never inside allocation (I6).`
      );
    }
    if (lot.remainingQuantity.amount.lessThanOrEqualTo(0)) continue;

    const take = Decimal.min(remaining, lot.remainingQuantity.amount);
    if (take.lessThanOrEqualTo(0)) continue;

    allocations.push({
      lotId: lot.lotId,
      quantity: quantity(take, required.unit),
      unitCost: lot.unitCost,
    });
    if (lot.unitCost === null) anyUnknownCost = true;

    remaining = remaining.minus(take);
  }

  const shortfall = remaining.greaterThan(0) ? quantity(remaining, required.unit) : null;

  const totalCost =
    allocations.length === 0 || anyUnknownCost
      ? null
      : allocations.reduce<Money>(
          (sum, a) => addMoney(sum, scaleMoney(a.unitCost as Money, a.quantity.amount)),
          zeroMoney((allocations[0]!.unitCost as Money).currency)
        );

  return { allocations, shortfall, totalCost };
};
