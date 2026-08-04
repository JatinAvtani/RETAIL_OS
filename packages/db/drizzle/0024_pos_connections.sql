-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- 006-03 (spec 13 §13.3): one store's link to a vendor POS account. Reuses sales_source (0023) for
-- vendor rather than a narrower enum — asked the user, confirmed 'csv' simply never appears as a
-- real row (CSV import is a one-off upload, no persistent connection).

CREATE TYPE "pos_connection_status" AS ENUM ('CONNECTED', 'DEGRADED', 'FAILED', 'EXPIRED', 'DISCONNECTED');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pos_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"vendor" "sales_source" NOT NULL,
	"external_account_id" text NOT NULL,
	"external_location_id" text,
	"access_token_ciphertext" text NOT NULL,
	"refresh_token_ciphertext" text,
	"token_expires_at" timestamp with time zone,
	"status" "pos_connection_status" DEFAULT 'CONNECTED' NOT NULL,
	"last_successful_sync_at" timestamp with time zone,
	"last_error" text,
	"connected_by_user_id" uuid,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "pos_connections" ADD CONSTRAINT "pos_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_connections" ADD CONSTRAINT "pos_connections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_connections" ADD CONSTRAINT "pos_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Exactly one connection per (store, vendor) — a store cannot have two simultaneous Square connections.
CREATE UNIQUE INDEX IF NOT EXISTS "pos_connections_store_vendor_idx" ON "pos_connections" ("store_id", "vendor");
--> statement-breakpoint

-- Tenant-first composite index, same convention as every other tenant table's primary read path.
CREATE INDEX IF NOT EXISTS "pos_connections_org_status_idx" ON "pos_connections" ("organization_id", "status");
--> statement-breakpoint

-- RLS: direct organization_id column, standard tenant_isolation policy.
ALTER TABLE "pos_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pos_connections"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
