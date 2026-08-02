-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why); every
-- migration since then is hand-written to avoid `generate` re-emitting unrelated prior tables as
-- "new" against a stale baseline.
CREATE TYPE "public"."supplier_status" AS ENUM('active', 'inactive');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contacts" jsonb,
	"payment_terms" text,
	"lead_time_days_contracted" integer,
	"lead_time_days_measured" integer,
	"delivery_days" integer[],
	"order_cutoff_time" time,
	"min_order_value" numeric(19, 4),
	"status" "supplier_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"supplier_sku" text NOT NULL,
	"supplier_description" text,
	"pack_size" numeric(19, 6),
	"pack_unit_id" uuid,
	"conversion_to_base" numeric(19, 9),
	"is_confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"source_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_pack_unit_id_units_id_fk" FOREIGN KEY ("pack_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_prices" ADD CONSTRAINT "supplier_prices_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Effective-dating enforced by the database, not application code (plan.md Phase 3): two price
-- rows for the same supplier_product can never have overlapping validity ranges. `valid_to IS
-- NULL` means "still in effect" — tstzrange's default upper bound of NULL is unbounded, so this
-- correctly excludes a new open-ended row from overlapping an existing open-ended one too.
-- Requires btree_gist (see docker/postgres/init/01-extensions.sql) for GiST to index
-- supplier_product_id's plain UUID equality alongside the range.
ALTER TABLE "supplier_prices" ADD CONSTRAINT "supplier_prices_no_overlapping_validity"
  EXCLUDE USING gist (
    "supplier_product_id" WITH =,
    tstzrange("valid_from", "valid_to") WITH &&
  );
--> statement-breakpoint

-- RLS: suppliers and supplier_products are directly tenant-scoped (real organization_id column).
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "suppliers"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "supplier_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_products" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier_products"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

-- supplier_prices has no organization_id of its own (a price only means anything in the context
-- of its supplier_product) — same subquery-based policy shape as product_variants.
ALTER TABLE "supplier_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_prices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier_prices"
  USING (
    EXISTS (
      SELECT 1 FROM "supplier_products"
      WHERE "supplier_products"."id" = "supplier_prices"."supplier_product_id"
      AND "supplier_products"."organization_id" = current_setting('app.current_org_id')::uuid
    )
  );
