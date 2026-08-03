-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- The projection (spec 08 SS8.6): a cache of "what's on hand right now," maintained in the SAME
-- transaction as every stock_movements insert. The ledger is truth; this table exists purely so
-- reads don't have to sum the ledger. Drift between this table and the ledger sum is a bug,
-- caught by the nightly reconciliation job (005-04), not built here.
CREATE TABLE IF NOT EXISTS "stock_levels" (
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(19, 6) DEFAULT '0' NOT NULL,
	"avg_unit_cost" numeric(19, 4),
	"last_movement_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("store_id", "product_id", "variant_id")
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Tenant-first composite index, same convention as every other tenant table's primary read path.
CREATE INDEX IF NOT EXISTS "stock_levels_org_store_idx" ON "stock_levels" ("organization_id", "store_id");
--> statement-breakpoint

-- RLS: direct organization_id column, standard tenant_isolation policy.
ALTER TABLE "stock_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_levels" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_levels"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
