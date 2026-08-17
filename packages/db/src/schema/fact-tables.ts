import { date, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { menuItems } from './recipes';
import { products, productVariants } from './products';
import { suppliers } from './suppliers';
import { purchaseOrders } from './purchase-orders';

/**
 * Fact tables (009-01, spec 12 §12.6, plan.md Phase 1) — the incrementally-maintained, per-tenant-
 * timezone daily aggregates every metric will EVENTUALLY read from instead of a live query over raw
 * transactional tables. Not built yet consumed by any registered metric — 009-02 through 009-15 all
 * shipped as live queries and stay that way; wiring metrics to read from facts instead is real,
 * separate follow-up work once these tables have real history to read.
 *
 * Every table here is `date`-partitioned (Postgres `date`, `mode: 'string'`, `YYYY-MM-DD`), matching
 * spec 08 §8.8's explicit "Fact tables: Monthly range, rebuild/backfill per partition" guidance and
 * `stock_movements`' own established partitioning template (migration `0014`) — see migration
 * `0039_fact_tables.sql` for the real `PARTITION BY RANGE` / RLS / grant structure, which Drizzle's
 * schema builder cannot express directly (same reason `stock_movements`' partitioning lives in a
 * hand-written migration, not `drizzle-kit generate` output).
 *
 * Two deliberate, confirmed scope narrowings from plan.md's literal 6-table list:
 * - `fact_supplier_events` is NOT built — confirmed with the user: `supplier_performance_events`
 *   (008-13) is already nearly this exact shape (`occurredAt`, `eventType`, `expectedValue`,
 *   `actualValue`, `variance`), append-only and small; aggregating it into a second, day-bucketed
 *   table would add real partitioning/RLS/job complexity for no query-performance or grain benefit
 *   over reading it directly. A future task can revisit this if a real need for a daily bucket
 *   surfaces.
 * - `fact_daily_consumption.theoreticalCogs` is a DOLLAR figure (reusing the exact real per-day
 *   recipe-cost-resolution pattern `sales_anomaly`'s `consumption_anomaly` detector already proved,
 *   009-11), not a per-INGREDIENT-PRODUCT `theoretical_qty`. A genuine per-product theoretical
 *   quantity would need real recipe explosion per sold menu item per day, aggregated back down to
 *   ingredient-product grain — materially harder and riskier than the dollar-cost version, and
 *   009-11's own consumption-anomaly detector already declined the equivalent work for the same
 *   underlying N+1-shaped explosion-cost reason. Confirmed with the user as a deliberate, narrower
 *   scope, not a silent drop of the spec's literal column name.
 */

/* ------------------------------------------------------------------ fact_daily_sales */

/**
 * Grain: one row per (org, store, date, menuItemId-or-null, posItemCategory-or-null, channel,
 * daypart). `menuItemId` is nullable — an unmapped POS item still sold real revenue and must not be
 * silently dropped from the fact table just because no human has mapped it yet (I7: the absence of a
 * mapping is not evidence the sale didn't happen). `posItemCategory` is the POS VENDOR's own
 * free-text category string (`pos_items.category`, e.g. Square's own catalog category name) —
 * confirmed with the user over the catalog's real `products.categoryId`, since a sales line links to
 * a `menu_item` (via `pos_items`), never directly to a `product`, so the catalog's own category
 * taxonomy isn't reachable at this grain without a heavier join through recipe explosion. Labeled
 * `posItemCategory`, not `category`, so this vendor-free-text provenance stays visible in the schema
 * itself, not just a comment.
 */
export const factDailySales = pgTable('fact_daily_sales', {
  id: uuid('id').notNull(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  date: date('date', { mode: 'string' }).notNull(),
  menuItemId: uuid('menu_item_id').references(() => menuItems.id),
  posItemCategory: text('pos_item_category'),
  channel: text('channel'),
  daypart: text('daypart'), // 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'LATE_NIGHT' — @retailos/domain's Daypart, not a DB enum (matches resolveLocalDaypart's own string-literal return type)
  units: numeric('units', { precision: 19, scale: 6 }).notNull(),
  grossRevenue: numeric('gross_revenue', { precision: 19, scale: 4 }).notNull(),
  discounts: numeric('discounts', { precision: 19, scale: 4 }).notNull(),
  refunds: numeric('refunds', { precision: 19, scale: 4 }).notNull(),
  netRevenue: numeric('net_revenue', { precision: 19, scale: 4 }).notNull(),
  transactionCount: numeric('transaction_count', { precision: 19, scale: 0 }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ fact_daily_consumption */

/**
 * Grain: one row per (org, store, date, productId, variantId) for real per-product consumption,
 * PLUS one additional sentinel row per (org, store, date) with `productId`/`variantId` both `NULL`
 * carrying that day's real STORE-WIDE `theoreticalCogs` — confirmed with the user over repeating
 * the store-wide total on every product row (which would silently double/triple-count on any naive
 * per-product sum) or dropping the column entirely. `theoreticalCogs` is `NULL` on every real
 * per-product row by construction; the sentinel row's own `actualQty`/`actualCogs` are `NULL` (a
 * real "not applicable" fact, not zero — this row represents no real consumption of its own).
 * `actualQty`/`actualCogs` come from real `stock_movements` `SALE_CONSUMPTION` rows (unambiguous
 * ground truth, I3's ledger). `unitCost` on a consumption movement is nullable (I7) — `actualCogs`
 * is `NULL` for a product/day whose consumption includes even one unknown-cost movement, never
 * silently zeroed. `theoreticalCogs` is the recipe-derived dollar figure (see this file's header
 * for why not a per-product quantity) — `NULL` when any sold menu item's recipe cost couldn't be
 * fully resolved that day, same I7 discipline.
 */
export const factDailyConsumption = pgTable('fact_daily_consumption', {
  id: uuid('id').notNull(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  date: date('date', { mode: 'string' }).notNull(),
  productId: uuid('product_id').references(() => products.id),
  variantId: uuid('variant_id').references(() => productVariants.id),
  actualQty: numeric('actual_qty', { precision: 19, scale: 6 }),
  actualCogs: numeric('actual_cogs', { precision: 19, scale: 4 }),
  theoreticalCogs: numeric('theoretical_cogs', { precision: 19, scale: 4 }),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ fact_daily_stock_value */

/**
 * Grain: one row per (org, store, date, productId, variantId) — a real end-of-day snapshot, not a
 * movement. `qtyOnHand`/`value` are `lots.remaining_quantity`/`(remaining_quantity * unit_cost)`
 * summed across every ACTIVE lot of that product/variant at that store, as of that day's close.
 * `lotsExpiring7d` is a real count of ACTIVE lots whose `expiry_date` falls within the 7 days
 * following this fact row's own `date` — the spec's literal `lots_expiring_7d` column.
 */
export const factDailyStockValue = pgTable('fact_daily_stock_value', {
  id: uuid('id').notNull(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  date: date('date', { mode: 'string' }).notNull(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  variantId: uuid('variant_id')
    .notNull()
    .references(() => productVariants.id),
  qtyOnHand: numeric('qty_on_hand', { precision: 19, scale: 6 }).notNull(),
  value: numeric('value', { precision: 19, scale: 4 }),
  lotsExpiring7d: numeric('lots_expiring_7d', { precision: 19, scale: 0 }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ fact_purchase_lines */

/**
 * Grain: one row per (org, store, date, supplierId, productId) — `date` is the parent PO's
 * `createdAt` (when the order was PLACED), confirmed with the user over the goods-receipt date,
 * matching `total_spend`/`spend_by_category`'s own already-established `createdAt`-based period
 * convention (009-08) so this fact table stays consistent with metrics that already exist. `po`/
 * `document` (plan.md's own column names) are real ids, not aggregated away — `poId`/`documentId`
 * here name the SINGLE po/document a line came from; a day with multiple POs for the same supplier/
 * product produces multiple fact rows (one per PO), never a merged one, so drill-through (009-16)
 * has a real single source to point at.
 */
export const factPurchaseLines = pgTable('fact_purchase_lines', {
  id: uuid('id').notNull(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  date: date('date', { mode: 'string' }).notNull(),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => suppliers.id),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  poId: uuid('po_id')
    .notNull()
    .references(() => purchaseOrders.id),
  qty: numeric('qty', { precision: 19, scale: 6 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
  total: numeric('total', { precision: 19, scale: 4 }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ fact_waste */

/**
 * Grain: one row per (org, store, date, productId, reasonCode) — real `stock_movements` `WASTE`
 * rows summed by day and reason. `value` is `NULL` for a day/reason bucket where even one wasted
 * unit had an unknown `unit_cost` (I7), matching `computeWasteValueForReason`'s own established
 * unknown-cost discipline (009-07) — never silently excluded from the qty total, only from value.
 */
export const factWaste = pgTable('fact_waste', {
  id: uuid('id').notNull(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  date: date('date', { mode: 'string' }).notNull(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  reasonCode: text('reason_code').notNull(),
  qty: numeric('qty', { precision: 19, scale: 6 }).notNull(),
  value: numeric('value', { precision: 19, scale: 4 }),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});
