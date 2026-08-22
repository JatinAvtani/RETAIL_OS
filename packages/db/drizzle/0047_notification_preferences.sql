-- notification_preferences — per-USER channel opt-out + quiet hours, genuinely different
-- scope from notification_rules.quiet_hours (per-tenant/per-rule, unused so far, kept as a
-- separate future org-wide override, not replaced by this table).
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"muted_channels" text[] DEFAULT '{}' NOT NULL,
	"quiet_hours_start_hour" integer,
	"quiet_hours_end_hour" integer,
	"critical_overrides_quiet_hours" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_preferences"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
-- One preferences row per (org, user) — the real upsert target fan-out reads from on every delivery.
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_org_user_idx" ON "notification_preferences" ("organization_id", "user_id");
