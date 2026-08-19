-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- earlier work's par-level/reorder-point storage (the scope's M3 milestone). Pure data - the full
-- reorder calculation is a separate, later task. Both value columns nullable, never
-- defaulted to 0 - "not configured" must stay distinguishable from "the threshold is zero".
CREATE TABLE IF NOT EXISTS "stock_par_levels" (
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"par_level" numeric(19, 6),
	"reorder_point" numeric(19, 6),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("store_id", "product_id", "variant_id")
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stock_par_levels" ADD CONSTRAINT "stock_par_levels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_par_levels" ADD CONSTRAINT "stock_par_levels_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_par_levels" ADD CONSTRAINT "stock_par_levels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_par_levels" ADD CONSTRAINT "stock_par_levels_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Tenant-first composite index, same convention as stock_levels' own read-path index.
CREATE INDEX IF NOT EXISTS "stock_par_levels_org_store_idx" ON "stock_par_levels" ("organization_id", "store_id");
--> statement-breakpoint

-- RLS: direct organization_id column, standard tenant_isolation policy.
ALTER TABLE "stock_par_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_par_levels" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_par_levels"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
