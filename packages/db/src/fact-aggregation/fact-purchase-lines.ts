import { generateId } from '@retailos/domain';

/**
 * `fact_purchase_lines`'s pure aggregation (009-01) — deliberately NOT a group-and-sum function
 * like every other fact table here. Grain is one row per real PO LINE (confirmed with the user,
 * `packages/db/src/schema/fact-tables.ts`'s own header) — there is nothing to aggregate; this is
 * a direct, real 1:1 mapping from a fetched line to its fact row, kept as its own named function
 * (not inlined at the call site) purely for the same fetch-then-compute layering every other fact
 * table follows, and so a future change to this table's grain has one clear place to change it.
 */

export type PurchaseLineForAggregation = {
  supplierId: string;
  poId: string;
  productId: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
};

export type FactPurchaseLineRow = {
  id: string;
  date: string;
  supplierId: string;
  productId: string;
  poId: string;
  qty: string;
  unitPrice: string;
  total: string;
};

export const computeFactPurchaseLines = (date: string, lines: PurchaseLineForAggregation[]): FactPurchaseLineRow[] =>
  lines.map((line) => ({
    id: generateId(),
    date,
    supplierId: line.supplierId,
    productId: line.productId,
    poId: line.poId,
    qty: line.qty,
    unitPrice: line.unitPrice,
    total: line.lineTotal,
  }));
