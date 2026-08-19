import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

/**
 * A physical zone within one store (walk-in fridge, dry storage, bar well) — the design's
 * "grouped by physical location" stocktake ordering (B11). Scoped to a `storeId`, not shared
 * across an org's stores: a walk-in fridge is a physical place inside one specific store, the
 * same reasoning `stores.ts` already gives for why stock/counts belong to a store rather than
 * directly to an org.
 *
 * Carries `organizationId` directly (unlike `product_variants`/`supplier_prices`/
 * `recipe_components`, which are subquery-scoped through a parent) because RLS in this project
 * has only ever set `app.current_org_id` (see tenant-context.ts) — there is no store-level
 * session variable to scope by instead, so the tenant boundary here is still the organization,
 * with `storeId` narrowing further within it.
 */
export const storageLocations = pgTable('storage_locations', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  name: text('name').notNull(),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
