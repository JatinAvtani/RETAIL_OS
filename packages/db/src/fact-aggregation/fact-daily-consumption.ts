import { Decimal } from 'decimal.js';
import { generateId } from '@retailos/domain';

/**
 * `fact_daily_consumption`'s pure aggregation (009-01). `theoreticalCogs` is a DOLLAR figure, not a
 * per-product quantity — see `packages/db/src/schema/fact-tables.ts`'s own header for the full,
 * confirmed reasoning (a genuine per-ingredient-product theoretical quantity needs real recipe
 * explosion per sold menu item per day, materially harder/riskier work 009-11's own
 * consumption-anomaly detector already declined for the identical underlying reason).
 * `theoreticalCogs` is a STORE-WIDE figure carried on every row of that store/day (not
 * apportioned per product) — see `computeFactDailyConsumption`'s own doc comment for why.
 */

export type ConsumptionRowForAggregation = {
  productId: string;
  variantId: string;
  quantity: string; // signed, negative for consumption — matches stock_movements' own convention
  unitCost: string | null;
};

export type SoldItemForTheoreticalCogs = {
  menuItemId: string;
  quantitySold: string;
};

export type RecipeUnitCostLookup = (menuItemId: string) => Promise<{ amount: string } | 'unknown'>;

export type FactDailyConsumptionRow = {
  id: string;
  date: string;
  productId: string | null;
  variantId: string | null;
  actualQty: string | null;
  actualCogs: string | null;
  theoreticalCogs: string | null;
};

/**
 * Groups real `SALE_CONSUMPTION` movements by (productId, variantId) — `actualQty` is the real
 * absolute quantity consumed (movements are signed negative; this fact table stores a positive
 * magnitude, matching every other fact table's own "quantity consumed/wasted" convention).
 * `actualCogs` is `null` (I7) for a product/variant whose day includes even ONE movement with an
 * unknown `unitCost` — a real, silent understatement risk if partially summed instead.
 *
 * `theoreticalCogs` is resolved separately (see `resolveTheoreticalCogsForDate`) and is a single
 * STORE-WIDE dollar total, not itemized per product — confirmed with the user: rather than
 * repeating it on every per-product row (a naive `SUM(theoretical_cogs)` across products would
 * silently double/triple-count it), it lands on its OWN dedicated sentinel row for this
 * (org, store, date) — `productId`/`variantId`/`actualQty`/`actualCogs` all `null` on that one row
 * (a real "not applicable" fact, not a fabricated zero). The sentinel row is appended ONLY when
 * `theoreticalCogs` is non-null OR real consumption rows exist for the day — an empty day produces
 * zero fact rows at all, never a lone sentinel carrying nothing.
 */
export const computeFactDailyConsumption = (
  date: string,
  consumptionRows: ConsumptionRowForAggregation[],
  theoreticalCogs: string | null
): FactDailyConsumptionRow[] => {
  type Group = { productId: string; variantId: string; qty: Decimal; cogs: Decimal; hasUnknownCost: boolean };
  const groups = new Map<string, Group>();

  for (const row of consumptionRows) {
    const key = `${row.productId}::${row.variantId}`;
    const existing = groups.get(key) ?? { productId: row.productId, variantId: row.variantId, qty: new Decimal(0), cogs: new Decimal(0), hasUnknownCost: false };
    const absQty = new Decimal(row.quantity).abs();
    existing.qty = existing.qty.plus(absQty);
    if (row.unitCost === null) {
      existing.hasUnknownCost = true;
    } else {
      existing.cogs = existing.cogs.plus(absQty.times(row.unitCost));
    }
    groups.set(key, existing);
  }

  const productRows: FactDailyConsumptionRow[] = [...groups.values()].map((group) => ({
    id: generateId(),
    date,
    productId: group.productId,
    variantId: group.variantId,
    actualQty: group.qty.toFixed(6),
    actualCogs: group.hasUnknownCost ? null : group.cogs.toFixed(4),
    theoreticalCogs: null,
  }));

  if (theoreticalCogs === null) return productRows;

  const sentinelRow: FactDailyConsumptionRow = {
    id: generateId(),
    date,
    productId: null,
    variantId: null,
    actualQty: null,
    actualCogs: null,
    theoreticalCogs,
  };
  return [...productRows, sentinelRow];
};

/**
 * Resolves the real store-wide theoretical COGS dollar total for one day — sums each sold menu
 * item's quantity times its real per-unit recipe cost (via the injected resolver, the SAME
 * production `resolveRecipeUnitCost` mechanism every other theoretical-COGS consumer uses, not a
 * duplicate formula, I2). `'unknown'`-mapped to `null` (I7) the moment ANY sold item's recipe cost
 * can't be resolved — a partial sum would silently understate the real total, exactly the failure
 * mode `computeCogsTheoretical` (`packages/metrics`) already guards against for the live-query path;
 * this fact-table path applies the identical all-or-nothing discipline.
 */
export const resolveTheoreticalCogsForDate = async (
  soldItems: SoldItemForTheoreticalCogs[],
  resolveUnitCost: RecipeUnitCostLookup
): Promise<string | null> => {
  if (soldItems.length === 0) return null;

  let total = new Decimal(0);
  const resolvedByMenuItem = new Map<string, { amount: string } | 'unknown'>();
  for (const item of soldItems) {
    if (!resolvedByMenuItem.has(item.menuItemId)) {
      resolvedByMenuItem.set(item.menuItemId, await resolveUnitCost(item.menuItemId));
    }
    const unitCost = resolvedByMenuItem.get(item.menuItemId)!;
    if (unitCost === 'unknown') return null;
    total = total.plus(new Decimal(item.quantitySold).times(unitCost.amount));
  }
  return total.toFixed(4);
};
