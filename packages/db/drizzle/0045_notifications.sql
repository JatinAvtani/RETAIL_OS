-- notification_rules, notifications, notification_deliveries — the schema the notifications
-- alert pipeline (rule evaluation -> dedup/aggregation -> delivery -> action tracking) depends on.
--
-- notification_deliveries.organization_id is a deliberate deviation from a purely-normalized
-- shape (deriving tenant via notification_id -> notifications.organization_id) — matching
-- messages.organization_id's own precedent (0043_conversations.sql): every tenant-scoped child
-- table in this codebase carries its own organization_id directly, so RLS stays a flat
-- organization_id = current_setting(...) predicate rather than a join-backed one.
CREATE TABLE IF NOT EXISTS "notification_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid,
	"rule_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold" jsonb NOT NULL,
	"severity" text NOT NULL,
	"recipient_roles" text[] NOT NULL,
	"channels" text[] NOT NULL,
	"quiet_hours" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid,
	"rule_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"dedup_key" text NOT NULL,
	"aggregation_group" text,
	"entity_type" text,
	"entity_id" uuid,
	"dollar_impact" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"acted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_status" AS ENUM('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'DEAD_LETTERED');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_rule_id_notification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- RLS matches every other tenant table's exact pattern — FORCE so even the table owner can't
-- bypass it, a real tenant-scoped predicate on organization_id, not a join-derived check.
ALTER TABLE "notification_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_rules"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_deliveries"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
-- Rule lookup during event evaluation: "which enabled rules of this type apply to this org/store".
CREATE INDEX IF NOT EXISTS "notification_rules_org_type_idx" ON "notification_rules" ("organization_id", "rule_type");
--> statement-breakpoint
-- Dedup lookup is the hot path in the rule-evaluation pipeline: "does an open notification with
-- this dedup_key already exist for this org" runs on every single rule evaluation.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_org_dedup_key_unresolved_idx" ON "notifications" ("organization_id", "dedup_key") WHERE "resolved_at" IS NULL;
--> statement-breakpoint
-- In-app notification centre: a user's/store's feed, most recent first.
CREATE INDEX IF NOT EXISTS "notifications_org_store_created_at_idx" ON "notifications" ("organization_id", "store_id", "created_at");
--> statement-breakpoint
-- Delivery worker's queue scan: "pending/failed deliveries for this org needing a retry attempt".
CREATE INDEX IF NOT EXISTS "notification_deliveries_org_status_idx" ON "notification_deliveries" ("organization_id", "status");
--> statement-breakpoint
-- A user's own notification centre: every delivery addressed to them, most recent first.
CREATE INDEX IF NOT EXISTS "notification_deliveries_org_user_idx" ON "notification_deliveries" ("organization_id", "user_id");
