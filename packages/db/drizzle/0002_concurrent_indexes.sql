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
