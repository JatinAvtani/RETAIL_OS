-- EPIC-015: one row per multi-hop investigation run (`runInvestigation`,
-- packages/assistant/src/investigate.ts) — created on-demand (a user's free-form question) or
-- PROACTIVELY (a worker consumer reacting to a newly created sales_anomaly/
-- supplier_price_increase-typed notification; confirmed via AskUserQuestion to run fully
-- automatically rather than lazily on open, so the trace + draft action already exist by the time
-- a human opens the finding). source_notification_id is null for an on-demand investigation.
--
-- status is what makes the proactive sweep idempotent: a notification already investigated
-- (COMPLETE/FAILED, both terminal) must never be investigated a second time on the next tick.
--
-- trace/draft are JSONB, matching messages.grounding_bundle's own established precedent for
-- persisting structured AI-pipeline output rather than normalizing every InvestigationStep/
-- ActionDraftResult field into its own column.
CREATE TYPE "public"."investigation_status" AS ENUM('RUNNING', 'COMPLETE', 'FAILED');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid,
	"source_notification_id" uuid,
	"question" text NOT NULL,
	"status" "investigation_status" DEFAULT 'RUNNING' NOT NULL,
	"hop_count" integer DEFAULT 0 NOT NULL,
	"trace" jsonb,
	"draft" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigations" ADD CONSTRAINT "investigations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigations" ADD CONSTRAINT "investigations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigations" ADD CONSTRAINT "investigations_source_notification_id_notifications_id_fk" FOREIGN KEY ("source_notification_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- RLS matches every other tenant table's exact pattern — FORCE so even the table owner can't
-- bypass it, a real tenant-scoped predicate on organization_id, not a join-derived check.
ALTER TABLE "investigations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "investigations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "investigations"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
-- The proactive sweep's own idempotency check: "does this notification already have a real
-- investigation row?" — tenant-first, matching every other index convention in this schema (I4).
CREATE UNIQUE INDEX IF NOT EXISTS "investigations_org_source_notification_idx"
  ON "investigations" ("organization_id", "source_notification_id")
  WHERE "source_notification_id" IS NOT NULL;
--> statement-breakpoint
-- A findings feed's own read path: an org's investigations, most recent first.
CREATE INDEX IF NOT EXISTS "investigations_org_created_at_idx" ON "investigations" ("organization_id", "created_at");
