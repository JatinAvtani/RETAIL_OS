ALTER TABLE "public"."memberships" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."membership_role";--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('OWNER', 'MANAGER', 'STAFF', 'VIEWER_FINANCE');--> statement-breakpoint
ALTER TABLE "public"."memberships" ALTER COLUMN "role" SET DATA TYPE "public"."membership_role" USING "role"::"public"."membership_role";