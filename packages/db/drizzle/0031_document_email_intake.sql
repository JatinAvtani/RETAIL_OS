-- Hand-written, matching every migration since 0005 (stale drizzle-kit snapshot chain).
--
-- inbound email intake for supplier invoices. `document_email_intake`
-- records every verified webhook delivery this server accepted (a sender allowlist per
-- tenant with quarantine for unknown senders), whether accepted, quarantined, or unresolved to any
-- organization at all. `organization_id` is deliberately nullable — a genuinely unresolvable
-- recipient slug means there is no tenant to scope the row to (see documents.ts schema comment for
-- the full reasoning) — so this table does NOT get the standard tenant_isolation RLS policy every
-- other tenant table gets; app-layer scoping (DocumentEmailIntakeRepository's own explicit
-- organization_id predicate) is the only defense here, by design, matching how this project treats
-- other genuinely-sometimes-tenantless tables.

CREATE TYPE "document_email_intake_status" AS ENUM ('ACCEPTED', 'QUARANTINED_UNKNOWN_SENDER', 'REJECTED_UNKNOWN_ORGANIZATION');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "document_email_intake" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"status" "document_email_intake_status" NOT NULL,
	"recipient_address" text NOT NULL,
	"sender_email" text NOT NULL,
	"sender_name" text,
	"subject" text,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "document_email_intake_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"intake_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "document_email_intake" ADD CONSTRAINT "document_email_intake_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_email_intake_attachments" ADD CONSTRAINT "email_intake_attachments_intake_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."document_email_intake"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Operator queue: "show me everything currently quarantined," most recent first, matching
-- documents_org_status_idx's own tenant-first-index reasoning where a real organization_id exists.
CREATE INDEX IF NOT EXISTS "document_email_intake_org_status_idx" ON "document_email_intake" ("organization_id", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "document_email_intake_attachments_intake_idx" ON "document_email_intake_attachments" ("intake_id");
