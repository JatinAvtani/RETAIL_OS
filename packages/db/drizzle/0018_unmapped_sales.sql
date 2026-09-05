-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- The quarantine queue: a sale line whose POS item can't be resolved to a
-- MenuItem. No FK to pos_items/sales_transactions - those tables don't exist yet (not
-- started); the raw external identifying fields are stored directly.
CREATE TYPE "unmapped_sale_status" AS ENUM ('UNRESOLVED', 'RESOLVED', 'IGNORED');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "unmapped_sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"pos_item_external_id" text NOT NULL,
	"pos_item_name" text NOT NULL,
	"quantity_sold" numeric(19, 6) NOT NULL,
	"revenue" numeric(19, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"status" "unmapped_sale_status" DEFAULT 'UNRESOLVED' NOT NULL,
	"resolved_menu_item_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "unmapped_sales" ADD CONSTRAINT "unmapped_sales_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unmapped_sales" ADD CONSTRAINT "unmapped_sales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unmapped_sales" ADD CONSTRAINT "unmapped_sales_resolved_menu_item_id_menu_items_id_fk" FOREIGN KEY ("resolved_menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Primary read path: the quarantine queue view, oldest-first, per tenant+store, unresolved only.
CREATE INDEX IF NOT EXISTS "unmapped_sales_org_store_status_idx" ON "unmapped_sales" ("organization_id", "store_id", "status", "occurred_at");
--> statement-breakpoint

-- A given POS item, once mapped, shouldn't quarantine again for the same external id within an
-- org — but the same external id CAN legitimately recur across sales (a burger sold 50 times a
-- day), so this indexes lookup by external id rather than uniquely constraining it.
CREATE INDEX IF NOT EXISTS "unmapped_sales_org_external_id_idx" ON "unmapped_sales" ("organization_id", "pos_item_external_id");
--> statement-breakpoint

-- RLS: direct organization_id column, standard tenant_isolation policy.
ALTER TABLE "unmapped_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unmapped_sales" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "unmapped_sales"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
