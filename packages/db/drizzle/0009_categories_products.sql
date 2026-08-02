-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why); every
-- migration since then is hand-written to avoid `generate` re-emitting unrelated prior tables as
-- "new" against a stale baseline.
CREATE TYPE "public"."product_tracking_policy" AS ENUM('NONE', 'LOT', 'SERIAL');
--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('INGREDIENT', 'SELLABLE', 'BOTH');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"base_unit_id" uuid NOT NULL,
	"tracking_policy" "product_tracking_policy" DEFAULT 'NONE' NOT NULL,
	"is_perishable" boolean DEFAULT false NOT NULL,
	"default_shelf_life_days" integer,
	"storage_location_id" uuid,
	"image_url" text,
	"type" "product_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"barcode" text,
	"attributes" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_base_unit_id_units_id_fk" FOREIGN KEY ("base_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- unit_conversions.product_id's FK was deferred in 0008 (products didn't exist yet) — add it now,
-- the expand-contract pattern's "contract" step. NOT VALID + VALIDATE would matter on a populated
-- table under load; this table has no application traffic yet so a plain ADD CONSTRAINT is fine.
DO $$ BEGIN
 ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- RLS: both new tenant tables get the standard ENABLE + FORCE + tenant_isolation policy.
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "categories"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "products"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

-- product_variants has no organization_id of its own (joins through product_id, like
-- product_variants' spec relationship) — RLS is enforced via a subquery against products, the
-- same shape a plain FK-following join would need anyway.
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_variants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "product_variants"
  USING (
    EXISTS (
      SELECT 1 FROM "products"
      WHERE "products"."id" = "product_variants"."product_id"
      AND "products"."organization_id" = current_setting('app.current_org_id')::uuid
    )
  );
