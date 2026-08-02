-- Hand-written, not `drizzle-kit generate` output: the last real snapshot on disk is
-- 0004_snapshot.json (0005/0006/0007 were themselves hand-written SQL with no snapshot recorded),
-- so a plain `generate` diffs against stale state and tries to re-emit invitations/google_id as
-- new. This file contains only the actual new tables for this migration, in the same shape
-- drizzle-kit produced for them before that stale-diff noise was stripped out.
CREATE TYPE "public"."unit_dimension" AS ENUM('MASS', 'VOLUME', 'COUNT');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"dimension" "unit_dimension" NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unit_conversions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_unit_id" uuid NOT NULL,
	"to_unit_id" uuid NOT NULL,
	"product_id" uuid,
	"factor" numeric(19, 9) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_from_unit_id_units_id_fk" FOREIGN KEY ("from_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_to_unit_id_units_id_fk" FOREIGN KEY ("to_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- RLS: units is a global lookup table (no organization_id column), like organizations/users —
-- not scoped, deliberately. unit_conversions IS tenant-scoped and gets the same
-- ENABLE + FORCE + tenant_isolation policy as every other tenant table (see 0001_rls_and_constraints.sql
-- for why ENABLE and FORCE are both required).
ALTER TABLE "unit_conversions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_conversions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "unit_conversions"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

-- Seed the fixed global unit vocabulary. This IS the vocabulary packages/domain's Unit type
-- names — mg/g/kg/ml/l/each — not organization data, so it belongs in a migration, not a
-- per-tenant seed script. IDs are real UUID v7 values pre-generated with the app's own
-- generateId() (packages/domain/src/primitives/id.ts) and hardcoded here — never
-- gen_random_uuid() (v4), per this project's standing id convention; a migration has no way to
-- call the application's TS generator at apply time, so the values are fixed in advance instead.
-- ON CONFLICT is a no-op guard for a re-run; the real uniqueness constraint (units_code_unique)
-- is added as a CONCURRENTLY index in the next migration, same split as every other unique index
-- in this project (see 0002_concurrent_indexes.sql for why).
INSERT INTO "units" ("id", "code", "dimension", "is_base") VALUES
  ('019fc132-0318-74e3-b063-d1ff4bdf80ad', 'mg', 'MASS', false),
  ('019fc132-0318-74e3-b063-d66be44e7b5a', 'g', 'MASS', true),
  ('019fc132-0318-74e3-b063-d94105342ce9', 'kg', 'MASS', false),
  ('019fc132-0318-74e3-b063-dc44b13b901e', 'ml', 'VOLUME', true),
  ('019fc132-0319-711e-b3a0-436339fa1130', 'l', 'VOLUME', false),
  ('019fc132-0319-711e-b3a0-470676caf991', 'each', 'COUNT', true)
ON CONFLICT DO NOTHING;
