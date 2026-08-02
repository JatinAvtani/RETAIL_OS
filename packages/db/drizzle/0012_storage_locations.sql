-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why); every
-- migration since then is hand-written to avoid `generate` re-emitting unrelated prior tables as
-- "new" against a stale baseline.
CREATE TABLE IF NOT EXISTS "storage_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- products.storage_location_id's FK was deferred since 0009 (storage_locations didn't exist yet)
-- — add it now, the expand-contract pattern's "contract" step. NOT VALID + VALIDATE would matter
-- on a populated table under load; this table has no application traffic yet so a plain ADD
-- CONSTRAINT is fine.
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_storage_location_id_storage_locations_id_fk" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- RLS: standard ENABLE + FORCE + tenant_isolation policy, same shape as every other directly
-- organization_id-scoped table (categories, products, suppliers, ...). storeId narrows further
-- within the org but isn't a separate RLS boundary — there is no app.current_store_id session
-- variable anywhere in this project (see tenant-context.ts), only app.current_org_id.
ALTER TABLE "storage_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "storage_locations"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
