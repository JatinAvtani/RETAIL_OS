-- A third role for the worker's admin/cross-tenant sweeps (findExpiryQueue, findNegativeStock,
-- findUnpublishedOutboxEvents, findActiveStoresForScheduling, findPendingConsumptionTransactions,
-- findOpenNotificationsByDedupPrefix, and the repository writes those sweeps make via
-- NotificationRepository/NotificationRuleRepository/SalesTransactionRepository) — every one of
-- these genuinely needs to see or update rows across every tenant in one query, which RLS
-- (correctly) refuses to any role without BYPASSRLS.
--
-- Before this role existed, those sweeps fell back to the `postgres` superuser connection
-- (`DATABASE_URL`) simply because it was the only already-configured connection that bypasses RLS
-- — real overreach: a superuser can also CREATE/DROP/ALTER any object, manage roles, and bypass
-- every other safety mechanism in the database, none of which any sweep actually needs. `retailos_
-- sweeper` has the SAME table-level grants as `retailos_app` (it composes the exact same repository
-- classes) plus BYPASSRLS, and nothing else — NOSUPERUSER, NOCREATEDB, NOCREATEROLE, matching
-- `retailos_app`'s own restriction shape.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retailos_sweeper') THEN
    CREATE ROLE retailos_sweeper LOGIN PASSWORD 'retailos_sweeper_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE retailos TO retailos_sweeper;
GRANT USAGE ON SCHEMA public TO retailos_sweeper;

-- Table-level grants must be explicit here (not just future ALTER DEFAULT PRIVILEGES) because this
-- role is created AFTER 02-app-role.sql's own default-privilege rule only applies to grants issued
-- BY THE ROLE THAT OWNS THE DEFAULT — every already-existing table needs its own GRANT for a
-- brand-new role, matching the standard Postgres "default privileges only apply going forward,
-- from the session that set them" behavior.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO retailos_sweeper;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO retailos_sweeper;

-- Keeps `retailos_sweeper` correctly provisioned for any table a FUTURE migration adds, the same
-- way 02-app-role.sql already does for retailos_app — migrations run as the `postgres` superuser,
-- so it's the role issuing CREATE TABLE that must declare this, once, here.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO retailos_sweeper;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO retailos_sweeper;
