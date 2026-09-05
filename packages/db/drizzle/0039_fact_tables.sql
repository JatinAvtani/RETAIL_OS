-- Hand-written, not `drizzle-kit generate` output — same reason as every prior partitioned-table
-- migration (0014_stock_movements.sql): the snapshot chain has been stale since migration 0005.
--
-- Fact tables, following the "monthly range, rebuild/backfill per partition" design
-- guidance. Five tables — `fact_supplier_events` is deliberately omitted as redundant with the
-- already-existing `supplier_performance_events` (see `packages/db/src/schema/fact-tables.ts`'s
-- own header for the full reasoning). Every table follows `stock_movements`' exact partitioning template:
-- `PARTITION BY RANGE (date)`, `PRIMARY KEY (id, date)` (the partition key must be in the PK),
-- one pre-created current-month partition + a DEFAULT catch-all, a BRIN index on `date`, plain
-- (non-CONCURRENTLY) indexes since every partition starts empty, RLS enabled+forced on the parent
-- only (partitions inherit it automatically).

/* ============================================================ fact_daily_sales */

CREATE TABLE IF NOT EXISTS "fact_daily_sales" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"date" date NOT NULL,
	"menu_item_id" uuid,
	"pos_item_category" text,
	"channel" text,
	"daypart" text,
	"units" numeric(19, 6) NOT NULL,
	"gross_revenue" numeric(19, 4) NOT NULL,
	"discounts" numeric(19, 4) NOT NULL,
	"refunds" numeric(19, 4) NOT NULL,
	"net_revenue" numeric(19, 4) NOT NULL,
	"transaction_count" numeric(19, 0) NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "date")
) PARTITION BY RANGE ("date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_daily_sales_2026_08"
  PARTITION OF "fact_daily_sales"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_daily_sales_default"
  PARTITION OF "fact_daily_sales" DEFAULT;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fact_daily_sales" ADD CONSTRAINT "fact_daily_sales_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_daily_sales" ADD CONSTRAINT "fact_daily_sales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_daily_sales" ADD CONSTRAINT "fact_daily_sales_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Idempotent-rebuild key: re-running the same tenant/store/day/grain must overwrite, never
-- duplicate — "fully rebuildable from source" is only true if this holds. NULLS are
-- allowed to repeat in a unique index only when Postgres treats NULL as distinct-from-NULL (the
-- default), which is exactly wrong here — a day with 3 unmapped-menu-item rows would violate
-- nothing and silently accumulate duplicates on every rebuild. COALESCE against a real sentinel
-- UUID/empty-string avoids that: NULL menu_item_id/category/channel/daypart are still compared as
-- equal-to-themselves across rebuild runs.
CREATE UNIQUE INDEX IF NOT EXISTS "fact_daily_sales_grain_unique" ON "fact_daily_sales" (
  "organization_id", "store_id", "date",
  COALESCE("menu_item_id", '00000000-0000-0000-0000-000000000000'),
  COALESCE("pos_item_category", ''),
  COALESCE("channel", ''),
  COALESCE("daypart", '')
);
CREATE INDEX IF NOT EXISTS "fact_daily_sales_org_store_date_idx" ON "fact_daily_sales" ("organization_id", "store_id", "date");
CREATE INDEX IF NOT EXISTS "fact_daily_sales_date_brin_idx" ON "fact_daily_sales" USING brin ("date");
--> statement-breakpoint

ALTER TABLE "fact_daily_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fact_daily_sales" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fact_daily_sales"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

/* ============================================================ fact_daily_consumption */

CREATE TABLE IF NOT EXISTS "fact_daily_consumption" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"date" date NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"actual_qty" numeric(19, 6) NOT NULL,
	"actual_cogs" numeric(19, 4),
	"theoretical_cogs" numeric(19, 4),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "date")
) PARTITION BY RANGE ("date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_daily_consumption_2026_08"
  PARTITION OF "fact_daily_consumption"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_daily_consumption_default"
  PARTITION OF "fact_daily_consumption" DEFAULT;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fact_daily_consumption" ADD CONSTRAINT "fact_daily_consumption_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_daily_consumption" ADD CONSTRAINT "fact_daily_consumption_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_daily_consumption" ADD CONSTRAINT "fact_daily_consumption_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_daily_consumption" ADD CONSTRAINT "fact_daily_consumption_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fact_daily_consumption_grain_unique" ON "fact_daily_consumption" ("organization_id", "store_id", "date", "product_id", "variant_id");
CREATE INDEX IF NOT EXISTS "fact_daily_consumption_org_store_date_idx" ON "fact_daily_consumption" ("organization_id", "store_id", "date");
CREATE INDEX IF NOT EXISTS "fact_daily_consumption_date_brin_idx" ON "fact_daily_consumption" USING brin ("date");
--> statement-breakpoint

ALTER TABLE "fact_daily_consumption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fact_daily_consumption" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fact_daily_consumption"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

/* ============================================================ fact_daily_stock_value */

CREATE TABLE IF NOT EXISTS "fact_daily_stock_value" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"date" date NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty_on_hand" numeric(19, 6) NOT NULL,
	"value" numeric(19, 4),
	"lots_expiring_7d" numeric(19, 0) NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "date")
) PARTITION BY RANGE ("date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_daily_stock_value_2026_08"
  PARTITION OF "fact_daily_stock_value"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_daily_stock_value_default"
  PARTITION OF "fact_daily_stock_value" DEFAULT;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fact_daily_stock_value" ADD CONSTRAINT "fact_daily_stock_value_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_daily_stock_value" ADD CONSTRAINT "fact_daily_stock_value_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_daily_stock_value" ADD CONSTRAINT "fact_daily_stock_value_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_daily_stock_value" ADD CONSTRAINT "fact_daily_stock_value_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fact_daily_stock_value_grain_unique" ON "fact_daily_stock_value" ("organization_id", "store_id", "date", "product_id", "variant_id");
CREATE INDEX IF NOT EXISTS "fact_daily_stock_value_org_store_date_idx" ON "fact_daily_stock_value" ("organization_id", "store_id", "date");
CREATE INDEX IF NOT EXISTS "fact_daily_stock_value_date_brin_idx" ON "fact_daily_stock_value" USING brin ("date");
--> statement-breakpoint

ALTER TABLE "fact_daily_stock_value" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fact_daily_stock_value" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fact_daily_stock_value"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

/* ============================================================ fact_purchase_lines */

CREATE TABLE IF NOT EXISTS "fact_purchase_lines" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"date" date NOT NULL,
	"supplier_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"qty" numeric(19, 6) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "date")
) PARTITION BY RANGE ("date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_purchase_lines_2026_08"
  PARTITION OF "fact_purchase_lines"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_purchase_lines_default"
  PARTITION OF "fact_purchase_lines" DEFAULT;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fact_purchase_lines" ADD CONSTRAINT "fact_purchase_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_purchase_lines" ADD CONSTRAINT "fact_purchase_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_purchase_lines" ADD CONSTRAINT "fact_purchase_lines_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_purchase_lines" ADD CONSTRAINT "fact_purchase_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_purchase_lines" ADD CONSTRAINT "fact_purchase_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- One row per real PO LINE (not merged across POs), so grain includes po_id itself.
CREATE UNIQUE INDEX IF NOT EXISTS "fact_purchase_lines_grain_unique" ON "fact_purchase_lines" ("organization_id", "po_id", "product_id", "date");
CREATE INDEX IF NOT EXISTS "fact_purchase_lines_org_store_date_idx" ON "fact_purchase_lines" ("organization_id", "store_id", "date");
CREATE INDEX IF NOT EXISTS "fact_purchase_lines_date_brin_idx" ON "fact_purchase_lines" USING brin ("date");
--> statement-breakpoint

ALTER TABLE "fact_purchase_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fact_purchase_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fact_purchase_lines"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

/* ============================================================ fact_waste */

CREATE TABLE IF NOT EXISTS "fact_waste" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"date" date NOT NULL,
	"product_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"qty" numeric(19, 6) NOT NULL,
	"value" numeric(19, 4),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "date")
) PARTITION BY RANGE ("date");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_waste_2026_08"
  PARTITION OF "fact_waste"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fact_waste_default"
  PARTITION OF "fact_waste" DEFAULT;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "fact_waste" ADD CONSTRAINT "fact_waste_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_waste" ADD CONSTRAINT "fact_waste_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fact_waste" ADD CONSTRAINT "fact_waste_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fact_waste_grain_unique" ON "fact_waste" ("organization_id", "store_id", "date", "product_id", "reason_code");
CREATE INDEX IF NOT EXISTS "fact_waste_org_store_date_idx" ON "fact_waste" ("organization_id", "store_id", "date");
CREATE INDEX IF NOT EXISTS "fact_waste_date_brin_idx" ON "fact_waste" USING brin ("date");
--> statement-breakpoint

ALTER TABLE "fact_waste" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fact_waste" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fact_waste"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
