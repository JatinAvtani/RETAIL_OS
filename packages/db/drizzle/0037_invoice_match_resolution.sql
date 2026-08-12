-- 008-12: variance review queue + resolution. One resolution action, PENDING -> RESOLVED directly
-- with a required reason (confirmed with the user) -- mirrors purchase_orders.rejectedAt/
-- rejectedByUserId/rejectionReason's exact column-triple convention.
ALTER TABLE "invoice_matches" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invoice_matches" ADD COLUMN IF NOT EXISTS "resolved_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "invoice_matches" ADD COLUMN IF NOT EXISTS "resolution_notes" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_matches" ADD CONSTRAINT "invoice_matches_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
