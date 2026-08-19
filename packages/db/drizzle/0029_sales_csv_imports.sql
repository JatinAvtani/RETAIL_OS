-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- CSV/Excel import's own state-machine table and per-tenant saved
-- column mappings. sales_csv_imports.status walks UPLOADED -> MAPPED -> IMPORTED | FAILED. The
-- uploaded file itself lives in object storage (packages/storage, same presigned-URL pattern as
-- products.requestImageUpload) — this table is the lifecycle/audit trail on top of it.

CREATE TYPE "csv_import_status" AS ENUM ('UPLOADED', 'MAPPED', 'IMPORTED', 'FAILED');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sales_csv_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"status" "csv_import_status" DEFAULT 'UPLOADED' NOT NULL,
	"detected_headers" jsonb,
	"column_mapping" jsonb,
	"total_row_count" integer,
	"imported_row_count" integer,
	"quarantined_row_count" integer,
	"skipped_row_count" integer,
	"error_summary" text,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "saved_csv_column_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"column_mapping" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "sales_csv_imports" ADD CONSTRAINT "sales_csv_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_csv_imports" ADD CONSTRAINT "sales_csv_imports_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saved_csv_column_mappings" ADD CONSTRAINT "saved_csv_column_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Tenant-first composite index, same convention as every other tenant table's primary read path.
CREATE INDEX IF NOT EXISTS "sales_csv_imports_org_status_idx" ON "sales_csv_imports" ("organization_id", "status");
--> statement-breakpoint

-- One label per org — "Toast export" means the same saved mapping every time a tenant picks it,
-- not a growing pile of same-named rows to disambiguate.
CREATE UNIQUE INDEX IF NOT EXISTS "saved_csv_column_mappings_org_label_idx" ON "saved_csv_column_mappings" ("organization_id", "label");
--> statement-breakpoint

-- RLS: direct organization_id column, standard tenant_isolation policy, both tables.
ALTER TABLE "sales_csv_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_csv_imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sales_csv_imports"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "saved_csv_column_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_csv_column_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "saved_csv_column_mappings"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
