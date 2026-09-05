-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- Inter-store transfers with a
-- real in-transit window. lot_status needs a new value: a destination lot exists but must be
-- invisible to FEFO (findFefoCandidates/consumeFefo only ever query status = 'ACTIVE') until the
-- transfer is actually received.
--
-- ALTER TYPE... ADD VALUE cannot run inside the same transaction as code that uses the new value
-- (a Postgres restriction on enum additions) - this migration ONLY adds the enum value; the
-- stock_transfers table is a separate statement in the same file, which is safe since table
-- creation doesn't reference the new enum value in a way that needs it committed first.
ALTER TYPE "lot_status" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
--> statement-breakpoint

CREATE TYPE "stock_transfer_status" AS ENUM ('PENDING', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_store_id" uuid NOT NULL,
	"destination_store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(19, 6) NOT NULL,
	"status" "stock_transfer_status" DEFAULT 'PENDING' NOT NULL,
	"source_lot_id" uuid,
	"destination_lot_id" uuid,
	"initiated_at" timestamp with time zone,
	"initiated_by_user_id" uuid,
	"received_at" timestamp with time zone,
	"received_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_source_store_id_stores_id_fk" FOREIGN KEY ("source_store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destination_store_id_stores_id_fk" FOREIGN KEY ("destination_store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_source_lot_id_lots_id_fk" FOREIGN KEY ("source_lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destination_lot_id_lots_id_fk" FOREIGN KEY ("destination_lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Tenant-first composite index, same convention as every other tenant table's primary read path.
CREATE INDEX IF NOT EXISTS "stock_transfers_org_status_idx" ON "stock_transfers" ("organization_id", "status");
--> statement-breakpoint

-- RLS: direct organization_id column, standard tenant_isolation policy.
ALTER TABLE "stock_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_transfers"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
