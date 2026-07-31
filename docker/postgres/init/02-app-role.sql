-- Non-superuser application role. The app must never connect as the `postgres` superuser: a
-- superuser silently bypasses RLS regardless of ENABLE/FORCE, which defeats the entire
-- tenant-isolation mechanism. Migrations still run as `postgres` (they need to CREATE TABLE /
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY), but the running application connects as
-- `retailos_app`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retailos_app') THEN
    CREATE ROLE retailos_app LOGIN PASSWORD 'retailos_app_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE retailos TO retailos_app;
GRANT USAGE ON SCHEMA public TO retailos_app;

-- Default privileges so tables created later (by migrations run as postgres) are automatically
-- usable by retailos_app without a manual GRANT per migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO retailos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO retailos_app;
