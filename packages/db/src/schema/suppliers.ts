import { integer, jsonb, numeric, pgEnum, pgTable, text, time, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

export const supplierStatusEnum = pgEnum('supplier_status', ['active', 'inactive']);

/**
 * Spec 07 §7.5 / 05 §5.3.1: contacts, terms, lead times (contracted AND measured), delivery
 * schedule, cut-off times, MOQ, payment terms, status.
 *
 * `leadTimeDaysContracted` (the promise) vs `leadTimeDaysMeasured` (reality) are deliberately two
 * separate columns, not one field a receiving event overwrites — reorder logic uses the measured
 * value once enough receipts exist, per plan.md, and overwriting the contracted figure would lose
 * the original agreement to compare against.
 *
 * `minOrderValue` is NUMERIC(19,4) like every other money column in this project (I5) —
 * interpreted in the organization's base_currency, same convention as
 * memberships.approvalLimit, since a supplier record has no currency of its own.
 */
export const suppliers = pgTable('suppliers', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  name: text('name').notNull(),
  // { name, email, phone, role }[] — kept as jsonb rather than a normalized table for the same
  // reason stores.operatingHours is jsonb: reporting only needs "who do we call," not a queryable
  // per-contact join.
  contacts: jsonb('contacts'),
  paymentTerms: text('payment_terms'),
  leadTimeDaysContracted: integer('lead_time_days_contracted'),
  leadTimeDaysMeasured: integer('lead_time_days_measured'),
  // ISO weekday numbers (1=Monday..7=Sunday), not a jsonb blob — a plain int[] is enough to
  // express "delivers Mon/Wed/Fri" and needs no further structure.
  deliveryDays: integer('delivery_days').array(),
  orderCutoffTime: time('order_cutoff_time'),
  minOrderValue: numeric('min_order_value', { precision: 19, scale: 4 }),
  status: supplierStatusEnum('status').notNull().default('active'),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
