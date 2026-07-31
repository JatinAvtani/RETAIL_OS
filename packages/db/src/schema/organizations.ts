import { pgTable, text } from 'drizzle-orm/pg-core';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

/**
 * The tenant boundary and billing unit (spec 07 SS7.2). Deliberately does NOT carry an
 * organization_id column — it IS the tenant, not a tenant-scoped row. Every other business
 * table's RLS policy resolves against this table's id via app.current_org_id.
 */
export const organizations = pgTable('organizations', {
  id: idColumn(),
  name: text('name').notNull(),
  baseCurrency: text('base_currency').notNull(),
  locale: text('locale').notNull().default('en-US'),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
