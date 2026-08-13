-- 008-13: spec 05 SS5.3.3, plan.md Phase 5. Only measured events -- no invented weights in MVP.
-- Fill rate / on-time rate / price variance / invoice accuracy / quality reject rate all read from
-- this table via the metric catalog (I2), never recomputed ad hoc from purchase_orders /
-- goods_receipts / invoice_matches directly.
CREATE TABLE IF NOT EXISTS "supplier_performance_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"purchase_order_id" uuid,
	"goods_receipt_id" uuid,
	"document_id" uuid,
	"product_id" uuid,
	"expected_value" numeric(19, 6),
	"actual_value" numeric(19, 6),
	"variance" numeric(19, 6),
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_performance_events" ADD CONSTRAINT "supplier_performance_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_performance_events" ADD CONSTRAINT "supplier_performance_events_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_performance_events" ADD CONSTRAINT "supplier_performance_events_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_performance_events" ADD CONSTRAINT "supplier_performance_events_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_performance_events" ADD CONSTRAINT "supplier_performance_events_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_performance_events" ADD CONSTRAINT "supplier_performance_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "supplier_performance_events_org_supplier_idx"
  ON "supplier_performance_events" ("organization_id", "supplier_id", "occurred_at");
--> statement-breakpoint

-- RLS: a real organization_id column -- same plain direct-column policy shape as
-- invoice_matches/goods_receipts.
ALTER TABLE "supplier_performance_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_performance_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier_performance_events"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
