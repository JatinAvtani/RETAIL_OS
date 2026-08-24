-- Hand-written, not `drizzle-kit generate` output — this snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- product/supplier CSV import's own state-machine table and per-tenant saved column
-- mappings, deliberately separate from sales_csv_imports (0029) — same UPLOADED -> MAPPED ->
-- IMPORTED | FAILED shape, parameterized by import_type instead of duplicated, but a different
-- domain (master/catalog data, not transactional sales history). Recipes are a real, deliberately
-- deferred follow-up (see own progress notes) — this table's import_type enum has room to
-- grow, but only PRODUCT/SUPPLIER are real today.

CREATE TYPE "catalog_csv_import_status" AS ENUM ('UPLOADED', 'MAPPED', 'IMPORTED', 'FAILED');
--> statement-breakpoint

CREATE TYPE "catalog_csv_import_type" AS ENUM ('PRODUCT', 'SUPPLIER');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "catalog_csv_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_type" "catalog_csv_import_type" NOT NULL,
	"storage_key" text NOT NULL,
	"status" "catalog_csv_import_status" DEFAULT 'UPLOADED' NOT NULL,
	"detected_headers" jsonb,
	"column_mapping" jsonb,
	"total_row_count" integer,
	"imported_row_count" integer,
	"skipped_row_count" integer,
	"error_summary" text,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "saved_catalog_csv_column_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_type" "catalog_csv_import_type" NOT NULL,
	"label" text NOT NULL,
	"column_mapping" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "catalog_csv_imports" ADD CONSTRAINT "catalog_csv_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saved_catalog_csv_column_mappings" ADD CONSTRAINT "saved_catalog_csv_column_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Tenant-first composite index, same convention as sales_csv_imports_org_status_idx.
CREATE INDEX IF NOT EXISTS "catalog_csv_imports_org_status_idx" ON "catalog_csv_imports" ("organization_id", "status");
--> statement-breakpoint

-- One label per (org, import_type) — "Toast product export" means the same saved mapping every
-- time, not a growing pile of same-named rows across two different import kinds.
CREATE UNIQUE INDEX IF NOT EXISTS "saved_catalog_csv_column_mappings_org_type_label_idx" ON "saved_catalog_csv_column_mappings" ("organization_id", "import_type", "label");
--> statement-breakpoint

-- RLS: direct organization_id column, standard tenant_isolation policy, both tables.
ALTER TABLE "catalog_csv_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_csv_imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "catalog_csv_imports"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "saved_catalog_csv_column_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_catalog_csv_column_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "saved_catalog_csv_column_mappings"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
