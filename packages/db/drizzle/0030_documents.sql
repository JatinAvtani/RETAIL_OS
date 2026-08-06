-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- 007-04 (plan.md Phase 1): documents.classification_confidence added on top of 007-01's schema
-- (this migration wasn't committed yet, so it's edited in place rather than stacking a second
-- migration on an uncommitted one) — the model's own subjective confidence in `type`, null until
-- classification has actually run (source = 'EMAIL'/'INTEGRATION' rows, or any row from before
-- classification existed). A distinct WARN-worthy state from a real 0.0 confidence value, so kept
-- nullable rather than defaulting to 0.
--
-- 007-01 (plan.md Phase 1): the document pipeline's schema — documents, document_extractions,
-- extraction_corrections, document_links. This is link 1 of the costing chain (invoice -> price ->
-- cost -> recipe -> margin), so every table here is org- AND store-scoped where the entity has a
-- store, and the three child tables denormalize organization_id directly (same convention
-- sales_transaction_lines established) rather than relying on a join back to documents for tenant
-- scoping.

CREATE TYPE "document_type" AS ENUM ('INVOICE', 'DELIVERY_NOTE', 'CREDIT_NOTE', 'QUOTE', 'CONTRACT', 'CERTIFICATE', 'OTHER');
--> statement-breakpoint

CREATE TYPE "document_source" AS ENUM ('UPLOAD', 'EMAIL', 'INTEGRATION');
--> statement-breakpoint

CREATE TYPE "document_status" AS ENUM ('UPLOADED', 'PROCESSING', 'REVIEW_REQUIRED', 'AUTO_APPROVED', 'APPROVED', 'REJECTED', 'POSTED');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"type" "document_type" NOT NULL,
	"classification_confidence" numeric(5, 4),
	"source" "document_source" NOT NULL,
	"status" "document_status" DEFAULT 'UPLOADED' NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "document_extractions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"fields" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"validation" jsonb NOT NULL,
	"overall_confidence" numeric(5, 4),
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "extraction_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"original_value" jsonb,
	"corrected_value" jsonb,
	"corrected_by_user_id" uuid NOT NULL,
	"corrected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "document_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_supersedes_id_documents_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "extraction_corrections" ADD CONSTRAINT "extraction_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "extraction_corrections" ADD CONSTRAINT "extraction_corrections_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "extraction_corrections" ADD CONSTRAINT "extraction_corrections_corrected_by_user_id_users_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_links" ADD CONSTRAINT "document_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Tenant-first composite indexes (§8.7), matching the spec's own literal example for this table:
-- CREATE INDEX ON documents(organization_id, created_at DESC) WHERE status = 'REVIEW_REQUIRED';
CREATE INDEX IF NOT EXISTS "documents_org_status_idx" ON "documents" ("organization_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_org_store_idx" ON "documents" ("organization_id", "store_id");
--> statement-breakpoint

-- Duplicate detection (spec 05 §5.6.3): "same content hash" is one of the two duplicate checks the
-- validation gate runs. Deliberately not unique (see documents.ts's own doc comment).
CREATE INDEX IF NOT EXISTS "documents_org_content_hash_idx" ON "documents" ("organization_id", "content_hash");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "document_extractions_org_document_idx" ON "document_extractions" ("organization_id", "document_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "extraction_corrections_org_extraction_idx" ON "extraction_corrections" ("organization_id", "extraction_id");
--> statement-breakpoint

-- Drill-through lookup: "every number a document produced" (by document) and "what document
-- produced this row" (by entity) are both real read paths (spec 07 §7.6's provenance use case).
CREATE INDEX IF NOT EXISTS "document_links_org_document_idx" ON "document_links" ("organization_id", "document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_links_org_entity_idx" ON "document_links" ("organization_id", "entity_type", "entity_id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "document_links_document_entity_relationship_idx" ON "document_links" ("document_id", "entity_type", "entity_id", "relationship");
--> statement-breakpoint

-- RLS: direct organization_id column on all four tables, standard tenant_isolation policy.
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "documents"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "document_extractions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_extractions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "document_extractions"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "extraction_corrections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "extraction_corrections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "extraction_corrections"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

ALTER TABLE "document_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "document_links"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
