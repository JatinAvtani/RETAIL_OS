-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- 006-01 (plan.md Phase 1): pos_items, sales_transactions, sales_transaction_lines. The first
-- schema for EPIC-006 (Sales Ingestion) — sales_transactions/pos_items didn't exist anywhere in
-- this codebase before this migration; EPIC-005's unmapped_sales/SaleConsumptionService were built
-- sales-source-agnostic specifically so they could be built before this table existed.

CREATE TYPE "sales_source" AS ENUM ('square', 'csv');
--> statement-breakpoint

CREATE TYPE "pos_item_mapping_status" AS ENUM ('UNMAPPED', 'MAPPED', 'IGNORED');
--> statement-breakpoint

CREATE TYPE "sales_transaction_status" AS ENUM ('COMPLETED', 'REFUNDED', 'VOIDED');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pos_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"source" "sales_source" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"price" numeric(19, 4),
	"currency" char(3),
	"category" text,
	"menu_item_id" uuid,
	"mapping_status" "pos_item_mapping_status" DEFAULT 'UNMAPPED' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sales_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"source" "sales_source" NOT NULL,
	"external_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"channel" text,
	"subtotal" numeric(19, 4) NOT NULL,
	"discount" numeric(19, 4) NOT NULL,
	"tax" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "sales_transaction_status" DEFAULT 'COMPLETED' NOT NULL,
	"refund_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sales_transaction_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"pos_item_id" uuid,
	"quantity" numeric(19, 6) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"discount" numeric(19, 4) NOT NULL,
	"line_total" numeric(19, 4) NOT NULL,
	"modifiers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "pos_items" ADD CONSTRAINT "pos_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_items" ADD CONSTRAINT "pos_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pos_items" ADD CONSTRAINT "pos_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_transactions" ADD CONSTRAINT "sales_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_transactions" ADD CONSTRAINT "sales_transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_transactions" ADD CONSTRAINT "sales_transactions_refund_of_id_sales_transactions_id_fk" FOREIGN KEY ("refund_of_id") REFERENCES "public"."sales_transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_transaction_lines" ADD CONSTRAINT "sales_transaction_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_transaction_lines" ADD CONSTRAINT "sales_transaction_lines_transaction_id_sales_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."sales_transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_transaction_lines" ADD CONSTRAINT "sales_transaction_lines_pos_item_id_pos_items_id_fk" FOREIGN KEY ("pos_item_id") REFERENCES "public"."pos_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Vendor-issued ids are only unique within one store's own POS account — two stores in the same
-- org, or the same org's two different Square locations, can trivially collide on external_id.
CREATE UNIQUE INDEX IF NOT EXISTS "pos_items_store_source_external_id_idx" ON "pos_items" ("store_id", "source", "external_id");
--> statement-breakpoint

-- Idempotency (006-07, plan.md Phase 3): the unique constraint .onConflictDoNothing() relies on.
-- Scoped per-organization (not globally) since the same external_id from two different orgs' own
-- vendor accounts is not the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS "sales_transactions_org_source_external_id_idx" ON "sales_transactions" ("organization_id", "source", "external_id");
--> statement-breakpoint

-- Tenant-first composite indexes, same convention as every other tenant table's primary read path.
CREATE INDEX IF NOT EXISTS "pos_items_org_mapping_status_idx" ON "pos_items" ("organization_id", "mapping_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_transactions_org_store_occurred_at_idx" ON "sales_transactions" ("organization_id", "store_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_transaction_lines_org_transaction_idx" ON "sales_transaction_lines" ("organization_id", "transaction_id");
--> statement-breakpoint

-- RLS: direct organization_id column on all three tables, standard tenant_isolation policy.
ALTER TABLE "pos_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pos_items"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "sales_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_transactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sales_transactions"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "sales_transaction_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_transaction_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sales_transaction_lines"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
