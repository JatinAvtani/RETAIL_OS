import { Decimal } from 'decimal.js';
import { generateId } from '@retailos/domain';

/**
 * `fact_waste`'s pure aggregation. Grain: (productId, reasonCode). `qty` is always the
 * real absolute quantity wasted; `value` is `null` (I7) the moment even one contributing movement
 * has an unknown `unit_cost` — never silently excluded from the qty total, matching
 * `computeWasteValueForReason`'s own established unknown-cost discipline exactly.
 */

export type WasteRowForAggregation = {
  productId: string;
  reasonCode: string | null; // NOT NULL by DB constraint on real WASTE rows; typed nullable to match the query's own column type honestly
  quantity: string;
  unitCost: string | null;
};

export type FactWasteRow = {
  id: string;
  date: string;
  productId: string;
  reasonCode: string;
  qty: string;
  value: string | null;
};

export const computeFactWaste = (date: string, rows: WasteRowForAggregation[]): FactWasteRow[] => {
  type Group = { productId: string; reasonCode: string; qty: Decimal; value: Decimal; hasUnknownCost: boolean };
  const groups = new Map<string, Group>();

  for (const row of rows) {
    // A real WASTE row always has a real reasonCode (DB CHECK constraint) — a row without one
    // here would mean the constraint was somehow bypassed; skip rather than fabricate a reason,
    // matching I7's "degrade to unknown, never guess" discipline applied to a grain key itself.
    if (row.reasonCode === null) continue;

    const key = `${row.productId}::${row.reasonCode}`;
    const existing = groups.get(key) ?? { productId: row.productId, reasonCode: row.reasonCode, qty: new Decimal(0), value: new Decimal(0), hasUnknownCost: false };
    const absQty = new Decimal(row.quantity).abs();
    existing.qty = existing.qty.plus(absQty);
    if (row.unitCost === null) {
      existing.hasUnknownCost = true;
    } else {
      existing.value = existing.value.plus(absQty.times(row.unitCost));
    }
    groups.set(key, existing);
  }

  return [...groups.values()].map((group) => ({
    id: generateId(),
    date,
    productId: group.productId,
    reasonCode: group.reasonCode,
    qty: group.qty.toFixed(6),
    value: group.hasUnknownCost ? null : group.value.toFixed(4),
  }));
};
