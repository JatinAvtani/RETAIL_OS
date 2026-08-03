-- CONCURRENTLY indexes: avoids an ACCESS EXCLUSIVE lock on the table while the
-- index builds. On an empty table (true for this first migration) the lock would be instant
-- either way, but the pattern is established from the first migration that adds indexes so it is
-- never "temporarily" skipped and then forgotten once these tables hold real data.
--
-- NOT run by `pnpm db:migrate` (Drizzle's migrate() wraps every migration in one transaction,
-- and CONCURRENTLY cannot run inside a transaction block). Run by `pnpm db:migrate:concurrent`
-- (src/migrate-concurrent.ts) instead, which executes each statement individually with no
-- surrounding transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "stores_org_idx" ON "stores" ("organization_id") WHERE "deleted_at" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "memberships_org_idx" ON "memberships" ("organization_id", "user_id") WHERE "deleted_at" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_org_idx" ON "audit_logs" ("organization_id", "occurred_at" DESC);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "memberships_org_user_unique" ON "memberships" ("organization_id", "user_id") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "users_email_unique" ON "users" ("email") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "organizations_slug_unique" ON "organizations" ("slug") WHERE "deleted_at" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "verification_tokens_lookup_idx" ON "verification_tokens" ("token_hash") WHERE "used_at" IS NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "users_google_id_unique" ON "users" ("google_id") WHERE "deleted_at" IS NULL AND "google_id" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "invitations_org_idx" ON "invitations" ("organization_id") WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "invitations_token_hash_unique" ON "invitations" ("token_hash");

-- Added for 0008_units_and_conversions.sql (units/unit_conversions), same CONCURRENTLY reasoning.
-- units is a small global lookup table, not tenant-scoped, so its index is a plain unique
-- constraint on code, not tenant-first.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "units_code_unique" ON "units" ("code");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "unit_conversions_org_idx" ON "unit_conversions" ("organization_id");
-- At most one row per (org, from_unit, to_unit, product) — product_id NULL (global-fallback row)
-- and product_id set (product-specific row) are both covered since Postgres unique indexes treat
-- NULL as distinct from any other NULL by default... except that means two NULL product_id rows
-- for the same org/from/to would NOT collide, which is wrong (there should be at most one global
-- fallback per unit pair per org). Two separate partial indexes close that gap precisely.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "unit_conversions_product_specific_unique" ON "unit_conversions" ("organization_id", "from_unit_id", "to_unit_id", "product_id") WHERE "product_id" IS NOT NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "unit_conversions_global_unique" ON "unit_conversions" ("organization_id", "from_unit_id", "to_unit_id") WHERE "product_id" IS NULL;

-- Added for 0009_categories_products.sql (categories/products/product_variants).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "categories_org_idx" ON "categories" ("organization_id") WHERE "deleted_at" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "categories_parent_idx" ON "categories" ("parent_id") WHERE "deleted_at" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_org_idx" ON "products" ("organization_id") WHERE "deleted_at" IS NULL;
-- Per plan.md Phase 2: deleted SKUs must be reusable, so the uniqueness constraint excludes
-- soft-deleted rows rather than being a plain (organization_id, sku) unique index.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "products_org_sku_unique" ON "products" ("organization_id", "sku") WHERE "deleted_at" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "product_variants_product_idx" ON "product_variants" ("product_id") WHERE "deleted_at" IS NULL;
-- At most one default variant per product — "every product gets a default variant on creation"
-- (plan.md) only holds if this is enforced, not just followed by convention in the repository.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "product_variants_one_default_per_product" ON "product_variants" ("product_id") WHERE "is_default" = true AND "deleted_at" IS NULL;

-- Added for 0010_suppliers_pricing.sql (suppliers/supplier_products/supplier_prices).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "suppliers_org_idx" ON "suppliers" ("organization_id") WHERE "deleted_at" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "supplier_products_org_idx" ON "supplier_products" ("organization_id");
-- A given supplier's SKU maps to at most one confirmed product mapping per org — matches spec
-- 05 SS5.3.2's "confirmed mapping stored permanently," enforced as a real constraint, not convention.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "supplier_products_supplier_sku_unique" ON "supplier_products" ("organization_id", "supplier_id", "supplier_sku");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "supplier_prices_supplier_product_idx" ON "supplier_prices" ("supplier_product_id");

-- Added for 0011_recipes.sql (recipes/recipe_components/menu_items).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "recipes_org_idx" ON "recipes" ("organization_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "recipes_group_idx" ON "recipes" ("recipe_group_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "recipe_components_recipe_idx" ON "recipe_components" ("recipe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "recipe_components_sub_recipe_group_idx" ON "recipe_components" ("sub_recipe_group_id") WHERE "sub_recipe_group_id" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "menu_items_org_idx" ON "menu_items" ("organization_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "menu_items_recipe_group_idx" ON "menu_items" ("recipe_group_id");

-- Added for 0012_storage_locations.sql. Tenant-first per project convention, plus a store-first
-- index since "all locations for this store" (populating a stocktake's grouping UI) is the
-- table's actual access pattern, not just "all locations for this org".
CREATE INDEX CONCURRENTLY IF NOT EXISTS "storage_locations_org_idx" ON "storage_locations" ("organization_id") WHERE "deleted_at" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "storage_locations_store_idx" ON "storage_locations" ("store_id") WHERE "deleted_at" IS NULL;
-- A location name is unique within its store (not globally, not per-org) — two different stores
-- in the same org can each have their own "Walk-in".
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "storage_locations_store_name_unique" ON "storage_locations" ("store_id", "name") WHERE "deleted_at" IS NULL;

-- stock_movements' indexes are NOT here — Postgres refuses CREATE INDEX CONCURRENTLY directly on
-- a partitioned parent table (no way to build one global concurrent index across partitions).
-- They're created transactionally on the parent in 0014_stock_movements.sql instead, which
-- Postgres propagates as a real (non-concurrent) index build on each existing partition — safe
-- here since every partition is empty at migration time.

-- Added for 0015_lots.sql. The workhorse index (plan.md, spec 08 SS8.6): serves BOTH FEFO
-- allocation (earliest expiry_date first, among ACTIVE lots with stock left) and the expiry
-- queue (005-15). Partial on the exact predicate every real query against this table filters by —
-- a lot that's DEPLETED or EXPIRED, or has zero remaining_quantity, is never a FEFO candidate.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "lots_fefo_idx" ON "lots" ("organization_id", "store_id", "product_id", "expiry_date") WHERE "status" = 'ACTIVE' AND "remaining_quantity" > 0;
-- Tenant-first lookup for anything not going through the FEFO path directly (e.g. a lot detail
-- view, or the repository's own findById).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "lots_org_idx" ON "lots" ("organization_id");
