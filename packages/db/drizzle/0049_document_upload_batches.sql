-- document_upload_batches — groups the documents from one bulk-upload session (012-02, spec 03
-- M9's "bulk invoice backfill") so a caller can poll real progress ("47 of 90 processed") scoped
-- to that session, not an all-time count. documents.upload_batch_id is nullable: a plain ad-hoc
-- upload has no batch at all.
CREATE TABLE IF NOT EXISTS "document_upload_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"expected_count" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_upload_batches" ADD CONSTRAINT "document_upload_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_upload_batches" ADD CONSTRAINT "document_upload_batches_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_upload_batches" ADD CONSTRAINT "document_upload_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "document_upload_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_upload_batches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_upload_batches"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "upload_batch_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_upload_batch_id_document_upload_batches_id_fk" FOREIGN KEY ("upload_batch_id") REFERENCES "public"."document_upload_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_upload_batch_id_idx" ON "documents" ("upload_batch_id");
