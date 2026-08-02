import { pgTable, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { idColumn, softDelete, timestamps, optimisticVersion } from './columns';

/**
 * Hierarchical, per-organization (spec 07 §7.3) — drives analytics grouping and reporting
 * rollups. Self-referencing via `parentId` (NULL = top-level category).
 *
 * `path` is a materialized, slash-delimited ancestor-id path (e.g. "/<rootId>/<childId>"),
 * maintained by the application layer on insert/move — not Postgres `ltree`, which isn't among
 * this project's enabled extensions (pgcrypto/pg_trgm/vector, see docker/postgres/init) and would
 * be a separate decision to add. A café/restaurant's category depth is shallow (2-3 levels), so a
 * simple indexed text-prefix path is sufficient for "all descendants of X" queries without the
 * extra extension.
 */
export const categories = pgTable('categories', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  parentId: uuid('parent_id').references((): AnyPgColumn => categories.id),
  name: text('name').notNull(),
  path: text('path').notNull(),
  ...timestamps,
  ...softDelete,
  ...optimisticVersion,
});
