-- Row-Level Security (spec 08 SS8.1) on every tenant table, without exception.
-- ENABLE + FORCE together: FORCE ensures even the table owner (the migration role) is subject to
-- the policy, not just other roles — otherwise a superuser or owner silently bypasses RLS, which
-- defeats the entire mechanism (I4).
--
-- current_setting() is called WITHOUT missing_ok=true deliberately: if a connection queries a
-- tenant table without first running SET LOCAL app.current_org_id (see src/tenant-context.ts),
-- this throws "unrecognized configuration parameter" instead of silently returning zero rows.
-- A loud error surfaces a real application bug immediately; missing_ok=true would make the same
-- bug look like "no data," which is far more likely to go unnoticed in development.
ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stores" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stores"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "memberships"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_logs"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

-- organizations and users are deliberately NOT RLS-scoped by organization_id: organizations IS
-- the tenant boundary (no organization_id column to filter on), and users is global identity
-- (one login can span multiple orgs via memberships). Scoping which orgs/users a caller may see
-- is an application-layer concern (e.g. "can only see orgs you have a membership in"), not a
-- row-level organization_id predicate — there is nothing here for RLS to filter on.
--> statement-breakpoint

-- Tenant-first composite indexes, and the partial unique indexes, are NOT here — spec 08 SS8.7
-- requires CREATE INDEX CONCURRENTLY to avoid an ACCESS EXCLUSIVE lock on populated tables, and
-- CONCURRENTLY cannot run inside a transaction block. Drizzle's migrate() wraps every migration
-- file in one transaction with no per-file opt-out, so these indexes are deliberately split into
-- 0002_concurrent_indexes.sql and applied by a separate, non-transactional runner
-- (src/migrate-concurrent.ts) instead of the normal `pnpm db:migrate`. See that file for why.
--> statement-breakpoint

-- audit_logs is append-only (I3): no UPDATE or DELETE, ever, enforced at the role level, not just
-- by application discipline. Corrections are new rows, never edits to history.
--
-- Revoked from PUBLIC *and* retailos_app explicitly: ALTER DEFAULT PRIVILEGES grants UPDATE/DELETE
-- directly to retailos_app (not via PUBLIC) when the table is created, so revoking only from
-- PUBLIC would leave the app role's own direct grant intact and this would silently do nothing.
REVOKE UPDATE, DELETE ON "audit_logs" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retailos_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "audit_logs" FROM retailos_app';
  END IF;
END
$$;
