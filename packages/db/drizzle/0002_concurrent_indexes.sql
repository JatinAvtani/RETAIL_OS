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
