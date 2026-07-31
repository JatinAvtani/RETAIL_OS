import { pgEnum, pgTable, smallint, text } from 'drizzle-orm/pg-core';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

/**
 * Coarse plan tier for MVP — expand via migration, not by adding a parallel column, when billing
 * needs finer-grained gating.
 */
export const organizationTierEnum = pgEnum('organization_tier', ['trial', 'standard']);

export const organizationStatusEnum = pgEnum('organization_status', ['active', 'suspended']);

/**
 * The tenant boundary and billing unit. Deliberately does NOT carry an organization_id column —
 * it IS the tenant, not a tenant-scoped row. Every other business
 * table's RLS policy resolves against this table's id via app.current_org_id.
 */
export const organizations = pgTable('organizations', {
  id: idColumn(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  baseCurrency: text('base_currency').notNull(),
  locale: text('locale').notNull().default('en-US'),
  // Month only (1-12); day is always the 1st. A CHECK constraint enforces the 1-12 range —
  // Drizzle's schema builder doesn't express column CHECKs, so it's added as raw SQL below.
  fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(1),
  tier: organizationTierEnum('tier').notNull().default('trial'),
  status: organizationStatusEnum('status').notNull().default('active'),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
