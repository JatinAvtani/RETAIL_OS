import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Decimal } from 'decimal.js';
import { quantity, money, suggestReorder, type ConsumptionDay, type CurrencyCode, type ReorderSuggestion, type Unit } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations } from '../schema/index';
import { withTenantContext } from '../tenant-context';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const CONSUMPTION_LOOKBACK_DAYS = 30;
const DEFAULT_COVERAGE_DAYS = 10;

export type ReorderSuggestionRow = {
  productId: string;
  variantId: string;
  productName: string;
  productSku: string;
  supplierId: string;
  supplierName: string;
  supplierProductId: string;
  supplierSku: string;
  unit: string | null;
  suggestion: ReorderSuggestion;
  explanationText: string;
};

export type SupplierGroupedSuggestions = {
  supplierId: string;
  supplierName: string;
  suggestions: ReorderSuggestionRow[];
};

/**
 * The plain-language rendering the plan's the design shows verbatim: "Suggest 3 cases (36 kg).
 * You use ~4.2 kg/day, have 9 kg (2.1 days), lead time is 2 days, target cover 10 days. Pack size
 * 12 kg." Built here (not in packages/domain) since it's presentation, not domain logic — the
 * suggestion's raw numbers are what packages/domain computes; how to phrase them for a manager is
 * this layer's job, matching every other plain-language-message precedent in this codebase
 * (validateExtraction's issue messages, integrations/health.ts's status messages).
 */
const renderExplanation = (suggestion: ReorderSuggestion, unit: string | null): string => {
  const u = unit ?? '';
  const qty = suggestion.quantity.amount.toDecimalPlaces(2).toString();
  const daily = suggestion.explanation.dailyConsumption.amount.toDecimalPlaces(2).toString();
  const cover =
    suggestion.explanation.currentCoverDays === null
      ? 'unknown current cover'
      : `${suggestion.explanation.currentCoverDays.toDecimalPlaces(1).toString()} days of cover`;
  const packText = suggestion.explanation.packSize
    ? ` Pack size ${suggestion.explanation.packSize.amount.toDecimalPlaces(2).toString()} ${u}.`
    : '';
  return (
    `Suggest ${qty} ${u}. You use ~${daily} ${u}/day, ${cover}, ` +
    `lead time is ${suggestion.explanation.leadTimeDays} day${suggestion.explanation.leadTimeDays === 1 ? '' : 's'}, ` +
    `target cover ${suggestion.explanation.coverageDays.toString()} days.${packText}`
  );
};

/**
 * wires earlier work's `suggestReorder` (pure domain logic) to real data for the first time.
 * Deliberately org-wide-per-store, one row per confirmed `supplier_products` mapping — an unmapped
 * supplier line has no pack size/MOQ/lead-time data to suggest against at all (I7: absence of a
 * mapping is not evidence a product needs reordering, so it's simply excluded, never defaulted).
 *
 * Per-input assembly, one real query at a time (matching `findExpiryQueue`'s own precedent of
 * deriving `avg_daily_consumption` inline since no stored value exists anywhere yet):
 *  - `stockOnHand` / `onOrder`: read directly, never computed by this function's own arithmetic on
 *    raw movement rows (I5 — money/quantity math belongs in packages/domain or a projection table,
 *    not ad-hoc here).
 *  - `consumptionHistory`: the trailing `CONSUMPTION_LOOKBACK_DAYS` days of `SALE_CONSUMPTION`
 *    movements, one row per day. A day with zero consumption movements is a REAL zero-consumption
 *    day (the store was open and nothing sold), not a closure — this codebase has no closure/
 *    operating-calendar table anywhere, so "closures excluded" cannot be
 *    honestly implemented yet; every returned day is marked `isClosureDay: false`. Flagged as a
 *    real, confirmed gap, not silently guessed around.
 *  - `leadTimeDays`/`minOrderValue`: read from `suppliers`, matching `supplierProducts`'s FK.
 *  - `unitPrice`: the supplier's most recent confirmed price for this supplier_product, if any —
 *    `null` when no price history exists yet, which correctly makes `enforceMoq` pass quantity
 *    through unchanged (I7) rather than fabricating a price.
 *
 * Returns suggestions grouped by supplier — spec's D10 ("order grouping by supplier... manager
 * orders per supplier, not per item") and the natural shape for earlier work's PO-creation flow to
 * consume directly (one PO per supplier group).
 */
export const findReorderSuggestions = async (
  db: Db,
  organizationId: string,
  storeId: string,
  asOf: Date = new Date()
): Promise<SupplierGroupedSuggestions[]> =>
  db.transaction((tx) => withTenantContext(tx, organizationId, () => runReorderSuggestionsQuery(tx, organizationId, storeId, asOf)));

const runReorderSuggestionsQuery = async (
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  organizationId: string,
  storeId: string,
  asOf: Date
): Promise<SupplierGroupedSuggestions[]> => {
  const asOfIso = asOf.toISOString();

  // The org's real base currency — minOrderValue/latest_unit_price below previously hardcoded
  // 'USD' regardless of organizations.baseCurrency, the same real bug fixed everywhere else in
  // this codebase's money-computing paths (matches recipes.ts's own established pattern).
  const [orgRow] = await tx
    .select({ baseCurrency: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const currency = (orgRow?.baseCurrency ?? 'USD') as CurrencyCode;

  const candidateRows = await tx.execute<{
    supplier_product_id: string;
    supplier_id: string;
    supplier_name: string;
    supplier_sku: string;
    pack_size: string | null;
    pack_unit_id: string | null;
    pack_unit_code: string | null;
    conversion_to_base: string | null;
    product_id: string;
    variant_id: string;
    product_name: string;
    product_sku: string;
    base_unit_id: string | null;
    base_unit_code: string | null;
    lead_time_days_measured: number | null;
    lead_time_days_contracted: number | null;
    min_order_value: string | null;
    stock_on_hand: string;
    on_order: string;
    latest_unit_price: string | null;
  }>(sql`
    WITH default_variant AS (
      SELECT DISTINCT ON (product_id) id AS variant_id, product_id
      FROM product_variants
      ORDER BY product_id, is_default DESC, created_at ASC
    ),
    on_order AS (
      SELECT
        pol.supplier_product_id,
        SUM(pol.quantity_base_units - COALESCE(pol.received_quantity_base_units, 0)) AS on_order_qty
      FROM purchase_order_lines pol
      INNER JOIN purchase_orders po ON po.id = pol.purchase_order_id
      WHERE po.organization_id = ${organizationId}
        AND po.store_id = ${storeId}
        AND po.status IN ('SENT', 'PARTIALLY_RECEIVED')
      GROUP BY pol.supplier_product_id
    ),
    latest_price AS (
      SELECT DISTINCT ON (supplier_product_id) supplier_product_id, unit_price
      FROM supplier_prices
      WHERE valid_to IS NULL
      ORDER BY supplier_product_id, valid_from DESC
    )
    SELECT
      sp.id AS supplier_product_id,
      sp.supplier_id,
      s.name AS supplier_name,
      sp.supplier_sku,
      sp.pack_size,
      sp.pack_unit_id,
      pack_unit.code AS pack_unit_code,
      sp.conversion_to_base,
      p.id AS product_id,
      dv.variant_id,
      p.name AS product_name,
      p.sku AS product_sku,
      p.base_unit_id,
      base_unit.code AS base_unit_code,
      s.lead_time_days_measured,
      s.lead_time_days_contracted,
      s.min_order_value,
      COALESCE(sl.quantity, 0) AS stock_on_hand,
      COALESCE(oo.on_order_qty, 0) AS on_order,
      lp.unit_price AS latest_unit_price
    FROM supplier_products sp
    INNER JOIN suppliers s ON s.id = sp.supplier_id
    INNER JOIN products p ON p.id = sp.product_id
    INNER JOIN default_variant dv ON dv.product_id = p.id
    LEFT JOIN units pack_unit ON pack_unit.id = sp.pack_unit_id
    LEFT JOIN units base_unit ON base_unit.id = p.base_unit_id
    LEFT JOIN on_order oo ON oo.supplier_product_id = sp.id
    LEFT JOIN latest_price lp ON lp.supplier_product_id = sp.id
    LEFT JOIN stock_levels sl
      ON sl.store_id = ${storeId}
     AND sl.product_id = p.id
     AND sl.variant_id = dv.variant_id
    WHERE sp.organization_id = ${organizationId}
      AND sp.is_confirmed = true
      AND p.deleted_at IS NULL
  `);

  if (candidateRows.length === 0) return [];

  const consumptionRows = await tx.execute<{
    product_id: string;
    consumption_date: string;
    daily_quantity: string;
  }>(sql`
    SELECT
      product_id,
      occurred_at::date AS consumption_date,
      SUM(-quantity) AS daily_quantity
    FROM stock_movements
    WHERE store_id = ${storeId}
      AND movement_type = 'SALE_CONSUMPTION'
      AND occurred_at >= ${asOfIso}::timestamptz - INTERVAL '${sql.raw(String(CONSUMPTION_LOOKBACK_DAYS))} days'
      AND occurred_at < ${asOfIso}::timestamptz
    GROUP BY product_id, occurred_at::date
  `);

  // Kept as raw (date, amount) pairs here — the real unit isn't known until the main loop below
  // reads each candidate's own base_unit_code, so tagging a Quantity this early would need a
  // throwaway placeholder unit. Re-tagged exactly once, with the real unit, per product.
  const consumptionByProduct = new Map<string, { date: Date; amount: string }[]>();
  for (const row of consumptionRows) {
    const list = consumptionByProduct.get(row.product_id) ?? [];
    list.push({ date: new Date(row.consumption_date), amount: row.daily_quantity });
    consumptionByProduct.set(row.product_id, list);
  }

  const bySupplier = new Map<string, SupplierGroupedSuggestions>();

  for (const row of candidateRows) {
    // products.baseUnitId is NOT NULL, so base_unit_code is only absent if the FK is somehow
    // broken — treated as a hard error rather than a guessed unit (I6: never assume a unit).
    if (row.base_unit_code === null) {
      throw new Error(`Product ${row.product_id} has no resolvable base unit — cannot compute a reorder suggestion.`);
    }
    const baseUnit = row.base_unit_code as Unit;
    const rawHistory = consumptionByProduct.get(row.product_id) ?? [];
    const consumptionHistory: ConsumptionDay[] = rawHistory.map((d) => ({
      date: d.date,
      quantityConsumed: quantity(d.amount, baseUnit),
      isClosureDay: false,
    }));

    const leadTimeDays = {
      measuredLeadTimeDays: row.lead_time_days_measured,
      contractedLeadTimeDays: row.lead_time_days_contracted,
      minOrderValue: row.min_order_value ? money(row.min_order_value, currency) : null,
    };

    const suggestion = suggestReorder({
      stockOnHand: quantity(row.stock_on_hand, baseUnit),
      onOrder: quantity(row.on_order, baseUnit),
      consumptionHistory,
      supplier: leadTimeDays,
      supplierProduct: {
        packSize: row.pack_size ? quantity(row.pack_size, baseUnit) : null,
      },
      unitPrice: row.latest_unit_price ? money(row.latest_unit_price, currency) : null,
      coverageDays: new Decimal(DEFAULT_COVERAGE_DAYS),
    });

    if (suggestion === null) continue;

    const suggestionRow: ReorderSuggestionRow = {
      productId: row.product_id,
      variantId: row.variant_id,
      productName: row.product_name,
      productSku: row.product_sku,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      supplierProductId: row.supplier_product_id,
      supplierSku: row.supplier_sku,
      unit: row.base_unit_code,
      suggestion,
      explanationText: renderExplanation(suggestion, row.base_unit_code),
    };

    const group = bySupplier.get(row.supplier_id) ?? { supplierId: row.supplier_id, supplierName: row.supplier_name, suggestions: [] };
    group.suggestions.push(suggestionRow);
    bySupplier.set(row.supplier_id, group);
  }

  return Array.from(bySupplier.values()).sort((a, b) => a.supplierName.localeCompare(b.supplierName));
};
