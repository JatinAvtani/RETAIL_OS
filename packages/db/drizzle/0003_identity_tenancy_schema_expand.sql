CREATE TYPE "public"."organization_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."organization_tier" AS ENUM('trial', 'standard');--> statement-breakpoint
CREATE TYPE "public"."store_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."verification_token_purpose" AS ENUM('email_verification', 'password_reset');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "verification_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_store_id_stores_id_fk";
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "slug" text NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "fiscal_year_start_month" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "tier" "organization_tier" DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "status" "organization_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "operating_hours" jsonb;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "status" "store_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "store_ids" uuid[];--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "approval_limit" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN IF EXISTS "store_id";
--> statement-breakpoint

-- CHECK constraints Drizzle's schema builder can't express directly on the column definition.
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_fiscal_year_start_month_range"
  CHECK ("fiscal_year_start_month" BETWEEN 1 AND 12);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_approval_limit_non_negative"
  CHECK ("approval_limit" IS NULL OR "approval_limit" >= 0);

-- organizations_slug_unique and verification_tokens_lookup_idx are CONCURRENTLY-created in
-- 0002_concurrent_indexes.sql instead of here, for the same reason the other CONCURRENTLY
-- indexes live there: this file runs inside Drizzle's migrate(), which wraps it in one
-- transaction, and CONCURRENTLY cannot run inside one.