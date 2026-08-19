-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- ⚠️ REMEMBER: this file must ALSO get an entry in drizzle/meta/_journal.json, or Drizzle's
-- migrate() silently never runs it (found the hard way building 0014_stock_movements.sql).
--
-- lots: a received batch with expiry and actual cost — the
-- workhorse for FEFO allocation, expiry tracking, and true cost-of-consumption. NOT partitioned
-- (unlike stock_movements) — the design's partitioning table only lists stock_movements,
-- sales_transactions/_lines, audit_logs, notifications, and fact tables; lots is a much smaller,
-- actively-queried-by-status table, not an append-only high-volume ledger.
CREATE TYPE "public"."lot_status" AS ENUM('ACTIVE', 'DEPLETED', 'EXPIRED');
--> statement-breakpoint

-- `goods_receipt_line_id` and `source_document_id` have no FK — the tables they'd reference
-- (purchasing/receiving, a later milestone; documents, a later milestone) don't exist yet in this codebase. Same
-- deferred-FK pattern already used for stock_movements.lot_id before this table existed: the
-- column is here now so a later migration doesn't need to add it, the real FK constraint arrives
-- once those epics build their tables.
CREATE TABLE IF NOT EXISTS "lots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"lot_number" text,
	"received_at" timestamp with time zone NOT NULL,
	"expiry_date" date,
	"initial_quantity" numeric(19, 6) NOT NULL,
	"remaining_quantity" numeric(19, 6) NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"supplier_id" uuid,
	"goods_receipt_line_id" uuid,
	"source_document_id" uuid,
	"status" "lot_status" NOT NULL DEFAULT 'ACTIVE',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "lots" ADD CONSTRAINT "lots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lots" ADD CONSTRAINT "lots_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lots" ADD CONSTRAINT "lots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lots" ADD CONSTRAINT "lots_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lots" ADD CONSTRAINT "lots_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The deferred FK from stock_movements.lot_id, now that lots exists — same
-- expand-contract "contract" step already used for unit_conversions.product_id → products.id.
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- A real CHECK, not just repository discipline: remaining_quantity can never exceed what was
-- initially received, and never goes negative — FEFO allocation/waste logging always subtracts,
-- never adds beyond the original receipt.
ALTER TABLE "lots" ADD CONSTRAINT "lots_remaining_within_initial"
  CHECK ("remaining_quantity" >= 0 AND "remaining_quantity" <= "initial_quantity");
--> statement-breakpoint

-- lots is NOT partitioned, unlike stock_movements — its indexes go through the normal
-- CONCURRENTLY path in 0002_concurrent_indexes.sql instead of being created here.

-- RLS: directly org-scoped, same shape as every other tenant table.
ALTER TABLE "lots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "lots"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
