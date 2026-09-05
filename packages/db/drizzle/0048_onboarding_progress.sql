-- onboarding_progress — one row per org, tracking the guided setup wizard's resumable/skippable
-- steps. Org creation + first store are already handled by auth.signup itself, so
-- the wizard's own tracked steps start from "connect sales."
CREATE TABLE IF NOT EXISTS "onboarding_progress" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"sales_connected_status" text DEFAULT 'PENDING' NOT NULL,
	"invoices_uploaded_status" text DEFAULT 'PENDING' NOT NULL,
	"entities_confirmed_status" text DEFAULT 'PENDING' NOT NULL,
	"par_levels_set_status" text DEFAULT 'PENDING' NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "onboarding_progress" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "onboarding_progress" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "onboarding_progress"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_progress_org_idx" ON "onboarding_progress" ("organization_id");
