-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why); every
-- migration since then is hand-written to avoid `generate` re-emitting unrelated prior tables as
-- "new" against a stale baseline.
CREATE TYPE "public"."recipe_component_type" AS ENUM('PRODUCT', 'RECIPE');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recipes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipe_group_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"yield_quantity" numeric(19, 6) NOT NULL,
	"yield_unit_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recipe_components" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipe_id" uuid NOT NULL,
	"component_type" "recipe_component_type" NOT NULL,
	"product_id" uuid,
	"sub_recipe_group_id" uuid,
	"quantity" numeric(19, 6) NOT NULL,
	"unit_id" uuid NOT NULL,
	"waste_factor" numeric(6, 4) DEFAULT '1.0000' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "menu_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"recipe_group_id" uuid NOT NULL,
	"price" numeric(19, 4) NOT NULL,
	"price_valid_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipes" ADD CONSTRAINT "recipes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipes" ADD CONSTRAINT "recipes_yield_unit_id_units_id_fk" FOREIGN KEY ("yield_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Exactly one of product_id / sub_recipe_group_id is set, matching component_type — a component
-- is EITHER a product OR a sub-recipe, never both, never neither.
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_exactly_one_reference"
  CHECK (
    ("component_type" = 'PRODUCT' AND "product_id" IS NOT NULL AND "sub_recipe_group_id" IS NULL) OR
    ("component_type" = 'RECIPE' AND "sub_recipe_group_id" IS NOT NULL AND "product_id" IS NULL)
  );
--> statement-breakpoint

-- Waste factor increases quantity, never decreases - enforced as a
-- real constraint, not just a domain-layer convention, so a bad row can never even be written.
ALTER TABLE "recipe_components" ADD CONSTRAINT "recipe_components_waste_factor_not_negative"
  CHECK ("waste_factor" >= 1);
--> statement-breakpoint

-- Effective-dating enforced by the database, identical mechanism to
-- supplier_prices: two versions of the SAME recipe (same recipe_group_id) can never have
-- overlapping validity periods. Requires btree_gist (see docker/postgres/init/01-extensions.sql,
-- enabled in migration 0010) for GiST to index recipe_group_id's plain UUID equality.
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_no_overlapping_versions"
  EXCLUDE USING gist (
    "recipe_group_id" WITH =,
    tstzrange("valid_from", "valid_to") WITH &&
  );
--> statement-breakpoint

-- RLS: recipes and menu_items are directly tenant-scoped.
ALTER TABLE "recipes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recipes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recipes"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "menu_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "menu_items"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

-- recipe_components has no organization_id of its own (a component only means anything via its
-- recipe_id) - same subquery-based policy shape as product_variants/supplier_prices.
ALTER TABLE "recipe_components" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recipe_components" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recipe_components"
  USING (
    EXISTS (
      SELECT 1 FROM "recipes"
      WHERE "recipes"."id" = "recipe_components"."recipe_id"
      AND "recipes"."organization_id" = current_setting('app.current_org_id')::uuid
    )
  );
