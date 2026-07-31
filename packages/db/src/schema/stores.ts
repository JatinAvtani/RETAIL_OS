import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

/**
 * A physical location — the operational unit. Stock, sales, staff, and counts belong to a store,
 * not directly to an org, because a meaningful share of the target segment expands to a
 * second location and retrofitting this dimension later is the single most expensive migration
 * this system could face.
 */
export const stores = pgTable('stores', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  address: text('address'),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
