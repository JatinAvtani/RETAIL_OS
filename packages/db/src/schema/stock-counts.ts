import { char, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { products, productVariants } from './products';
import { users } from './users';
import { idColumn, timestamps } from './columns';

export const stockCountStatusEnum = pgEnum('stock_count_status', [
  'DRAFT',
  'IN_PROGRESS',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
]);

/**
 * a stocktake session, `DRAFT → IN_PROGRESS → SUBMITTED → APPROVED |
 * REJECTED`. `scope` records what the plan calls "full | by
 * category | by storage location" — free text rather than a structured filter, since this
 * schema's job is recording the count session, not building the query that generated its scope.
 *
 * `t0At` is set exactly once, on the `DRAFT → IN_PROGRESS` transition — this is the moment every
 * line's `theoreticalQuantityT0` (see `stock-count-lines.ts`) is frozen. This is THE reason the
 * whole feature exists: the design's own words, "sales continue during a count... comparing a
 * count taken at 9am against a theoretical balance read at 11am produces phantom variance." Any
 * stock movement occurring after `t0At` is real, correct activity, deliberately excluded from
 * variance rather than treated as shrinkage.
 *
 * `approvedByUserId`/`approvedAt`/`rejectedByUserId`/`rejectedAt` are separate nullable pairs, not
 * one shared "resolvedBy"/"resolvedAt" — `APPROVED` and `REJECTED` are distinguishable terminal
 * states a caller can query independently (e.g. "show me every REJECTED count this quarter"),
 * mirroring `invitations`' separate `acceptedAt`/`revokedAt` columns for the same reason.
 */
export const stockCounts = pgTable('stock_counts', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  status: stockCountStatusEnum('status').notNull().default('DRAFT'),
  scope: text('scope').notNull(),
  t0At: timestamp('t0_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedByUserId: uuid('submitted_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectedByUserId: uuid('rejected_by_user_id').references(() => users.id),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  ...timestamps,
});

/**
 * One product/variant line within a count. `theoreticalQuantityT0`/`t0UnitCost` are frozen once,
 * at the parent count's `DRAFT → IN_PROGRESS` transition — never recomputed later, even if
 * `stock_levels`/`avg_unit_cost` change before the count is approved. `countedQuantity` starts
 * `NULL` (a line exists once the count scope is defined, but hasn't necessarily been physically
 * counted yet — I7: "not yet counted" must never read as "counted as zero").
 *
 * `varianceQuantity`/`varianceValue` are NOT generated columns — computed once, explicitly, at
 * submission time (`counted − theoretical_t0`, valued at `t0UnitCost`, the design's exact
 * formula) and stored, so a line's recorded variance reflects the values that were actually true
 * at submission, not a live recomputation against costs that may have since changed.
 *
 * `reasonCode` is free text here (unlike `stock_movements`' fixed waste-reason enum, earlier work) —
 * the design only says "large variances require a reason code," never naming a fixed
 * vocabulary the way it does for waste, so this deliberately isn't constrained to an enum.
 */
export const stockCountLines = pgTable('stock_count_lines', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  stockCountId: uuid('stock_count_id')
    .notNull()
    .references(() => stockCounts.id),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  variantId: uuid('variant_id')
    .notNull()
    .references(() => productVariants.id),
  theoreticalQuantityT0: numeric('theoretical_quantity_t0', { precision: 19, scale: 6 }),
  t0UnitCost: numeric('t0_unit_cost', { precision: 19, scale: 4 }),
  currency: char('currency', { length: 3 }),
  countedQuantity: numeric('counted_quantity', { precision: 19, scale: 6 }),
  countedAt: timestamp('counted_at', { withTimezone: true }),
  countedByUserId: uuid('counted_by_user_id').references(() => users.id),
  varianceQuantity: numeric('variance_quantity', { precision: 19, scale: 6 }),
  varianceValue: numeric('variance_value', { precision: 19, scale: 4 }),
  reasonCode: text('reason_code'),
  ...timestamps,
});
