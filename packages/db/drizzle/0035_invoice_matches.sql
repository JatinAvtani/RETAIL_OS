-- the design's InvoiceMatch -- the three-way match result linking
-- PO <-> Receipt <-> Document, with per-line variance classification.
CREATE TABLE IF NOT EXISTS "invoice_matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"highest_severity" text,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_match_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_match_id" uuid NOT NULL,
	"invoice_line_index" numeric(10, 0) NOT NULL,
	"purchase_order_line_id" uuid,
	"goods_receipt_line_id" uuid,
	"product_id" uuid,
	"invoice_sku" text,
	"invoice_quantity" numeric(19, 6),
	"invoice_unit_price" numeric(19, 4),
	"po_unit_price" numeric(19, 4),
	"received_quantity" numeric(19, 6),
	"price_variance" numeric(19, 4),
	"quantity_variance" numeric(19, 6),
	"variance_type" text NOT NULL,
	"variance_severity" text NOT NULL,
	"explanation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_matches" ADD CONSTRAINT "invoice_matches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_matches" ADD CONSTRAINT "invoice_matches_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_matches" ADD CONSTRAINT "invoice_matches_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_matches" ADD CONSTRAINT "invoice_matches_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_matches" ADD CONSTRAINT "invoice_matches_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_match_lines" ADD CONSTRAINT "invoice_match_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_match_lines" ADD CONSTRAINT "invoice_match_lines_invoice_match_id_invoice_matches_id_fk" FOREIGN KEY ("invoice_match_id") REFERENCES "public"."invoice_matches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_match_lines" ADD CONSTRAINT "invoice_match_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_match_lines" ADD CONSTRAINT "invoice_match_lines_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_match_lines" ADD CONSTRAINT "invoice_match_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- One match row per document -- matching is a computed result that could in principle be
-- re-run, but normal operation (one approve, one PostingService call) must never silently create
-- duplicates for the same invoice.
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_matches_document_unique"
  ON "invoice_matches" ("document_id");
--> statement-breakpoint

-- RLS: both tables carry a real organization_id column -- a plain direct-column policy, same
-- shape as goods_receipts/goods_receipt_lines.
ALTER TABLE "invoice_matches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_matches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoice_matches"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "invoice_match_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_match_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoice_match_lines"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
