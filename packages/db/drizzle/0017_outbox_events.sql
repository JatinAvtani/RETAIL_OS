-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- The transactional outbox (I8): a state change and its event commit together or
-- not at all. NOT partitioned (unlike stock_movements/audit_logs) - it isn't part of the
-- partitioning plan, since unpublished/published rows are short-lived operational data, not a
-- permanent append-only ledger.
CREATE TABLE IF NOT EXISTS "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Tenant-first composite index for the read path a future relay would use: unpublished rows,
-- oldest first, per tenant.
CREATE INDEX IF NOT EXISTS "outbox_events_unpublished_idx" ON "outbox_events" ("organization_id", "created_at") WHERE "published_at" IS NULL;
--> statement-breakpoint

-- RLS: direct organization_id column, standard tenant_isolation policy.
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "outbox_events"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
