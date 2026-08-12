-- 008-06: spec 05 SS5.2.2, "SENT triggers PDF generation + email to the supplier contact."
-- pdf_object_key records where the generated PDF landed in object storage (same tenant-prefixed
-- key convention as document-verification's buildDocumentKey) — nullable, since a PO in any
-- pre-SENT state has no PDF yet (I7: absence, not a fabricated empty string).
-- email_sent_at/email_sent_to record the mocked send outcome (this project's own no-card/no-cost
-- constraint means the transport is mocked, matching the Postmark-inbound precedent — see
-- packages/email/src/po-email-sender.ts) — kept on the row so "was this actually sent, and to
-- whom" is answerable without joining audit_logs.
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "pdf_object_key" text;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "email_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "email_sent_to" text;
