-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- the webhook receiver's durable, deduped event record. organization_id
-- is NOT NULL, matching every other tenant table's RLS convention — a webhook whose merchant_id
-- resolves to no known pos_connections row is never written here at all (logged server-side, 200
-- returned, no row), asked the user and confirmed rather than relaxing tenant-scoping.

CREATE TYPE "webhook_event_type" AS ENUM ('catalog.updated', 'transaction.updated');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"pos_connection_id" uuid NOT NULL,
	"source" "sales_source" NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" "webhook_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_pos_connection_id_pos_connections_id_fk" FOREIGN KEY ("pos_connection_id") REFERENCES "public"."pos_connections"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Idempotency: the same vendor event, retried any number of times, is recognized as already-seen.
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_org_source_external_event_id_idx" ON "webhook_events" ("organization_id", "source", "external_event_id");
--> statement-breakpoint

-- Tenant-first composite index, same convention as every other tenant table's primary read path.
CREATE INDEX IF NOT EXISTS "webhook_events_org_processed_at_idx" ON "webhook_events" ("organization_id", "processed_at");
--> statement-breakpoint

-- RLS: direct organization_id column, standard tenant_isolation policy.
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "webhook_events"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

-- A webhook arrives carrying only a vendor account identifier (Square's merchant_id) — no
-- organization_id is known yet, the same chicken-and-egg problem login's own membership lookup
-- solves (0005_login_membership_lookup.sql). pos_connections has FORCE ROW LEVEL SECURITY requiring
-- app.current_org_id to already be set; this SECURITY DEFINER function is the narrow, explicit,
-- single-purpose exception for exactly this one pre-tenant-context lookup.
CREATE FUNCTION find_pos_connection_by_external_account(p_vendor sales_source, p_external_account_id text)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  store_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.organization_id, c.store_id
  FROM pos_connections c
  WHERE c.vendor = p_vendor
    AND c.external_account_id = p_external_account_id
    AND c.status <> 'DISCONNECTED';
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION find_pos_connection_by_external_account(sales_source, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retailos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION find_pos_connection_by_external_account(sales_source, text) TO retailos_app';
  END IF;
END
$$;
