import { char, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { products, productVariants } from './products';
import { users } from './users';

export const movementTypeEnum = pgEnum('movement_type', [
  'RECEIPT',
  'SALE_CONSUMPTION',
  'WASTE',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'COUNT_ADJUSTMENT',
  'PRODUCTION_INPUT',
  'PRODUCTION_OUTPUT',
  'RETURN_TO_SUPPLIER',
  /**
   * 006-08: a refund reverses the consumption a sale posted — the ingredients notionally came
   * back into stock. A distinct value from `RETURN_TO_SUPPLIER` (a genuinely different real-world
   * event: inventory physically leaving to go back to a vendor) and from `WASTE` (which means
   * product was actually discarded, not that a sale was undone).
   */
  'SALE_REVERSAL',
]);

/**
 * 005-10 (spec 05 §5.1.5): the fixed set a `WASTE` movement's `reason_code` must be one of — "Free
 * text here would make the whole module worthless" per the spec's own words. Not a `pgEnum` like
 * `movementTypeEnum` — `reason_code` stays a plain `text` column (it's used generically across
 * every movement type, not just `WASTE`), enforced instead by a CHECK constraint scoped to `WASTE`
 * rows only (`stock_movements_waste_reason_code`, migration `0020`). This tuple is the single
 * source of truth both the constraint's literal values and this codebase's `WasteReasonCode` type
 * are derived from — keeping them in sync is a discipline, not machine-enforced across the two
 * layers, so if this list ever changes, the migration must change with it.
 */
export const wasteReasonCodeEnum = [
  'EXPIRED',
  'DAMAGED',
  'PREP_ERROR',
  'CUSTOMER_RETURN',
  'OVERPRODUCTION',
  'SPILLAGE',
  'QUALITY_REJECT',
  'THEFT_SUSPECTED',
] as const;

/**
 * The ledger (spec 07 §7.4) — the single factual record of everything that happened to stock.
 * Append-only: no UPDATE/DELETE, ever, enforced by revoking the grant from the application role
 * in the migration (see drizzle/0014_stock_movements.sql), not by application discipline alone.
 * Corrections are new compensating rows.
 *
 * Bi-temporal: `occurredAt` is business time (when the stock event actually happened —
 * a delivery that physically arrived Monday), `recordedAt` is system time (when it was entered —
 * possibly Wednesday). A single-timestamp design cannot represent backdated corrections.
 *
 * `quantity` is signed, in the product's base unit (I6 — no implicit conversion at this layer;
 * whatever calls into the movement service has already resolved the quantity to base units via
 * `resolveQuantity` at the boundary). `unitCost` is nullable, not defaulted to 0 (I7) — a movement
 * with unknown cost (e.g. a stocktake adjustment with no cost basis) must say so, not silently
 * report a free movement.
 *
 * PARTITION BY RANGE (occurred_at) and the partitions themselves are raw SQL in the migration —
 * Drizzle's schema builder cannot express partitioning (same limitation already noted on
 * audit_logs, which predates this table and was never actually partitioned; this one is, for
 * real, since 005-01 is the first task that actually needs the partitioning to exist).
 *
 * PRIMARY KEY is (id, occurred_at), not bare id — Postgres requires every unique index on a
 * partitioned table to include the partition key, since uniqueness can't be enforced across
 * partitions by a single index.
 *
 * `lotId` has no FK yet — `lots` (005-02) doesn't exist. Same deferred-FK pattern as
 * `unit_conversions.product_id` before `products` existed: the column is here now so this schema
 * doesn't need a later migration just to add it, the real FK constraint arrives with 005-02.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id),
    lotId: uuid('lot_id'),
    movementType: movementTypeEnum('movement_type').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 6 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 19, scale: 4 }),
    currency: char('currency', { length: 3 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    idempotencyKey: text('idempotency_key'),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    reasonCode: text('reason_code'),
    notes: text('notes'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.occurredAt] }),
  }),
);
