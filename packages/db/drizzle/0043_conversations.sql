-- conversations + messages — the schema the grounding-bundle-retention property depends on
-- ("retaining the bundle is what makes disputes resolvable").
--
-- messages.organization_id is a deliberate deviation from a first literal SQL sketch (which
-- has only conversation_id) — every other tenant-scoped child table in
-- this codebase that could derive its tenant via a parent join instead carries its own
-- organization_id directly (sales_transaction_lines, document_extractions, recipe_components),
-- for real RLS + defense-in-depth (I4), matching every existing table's flat
-- organization_id = current_setting(...) RLS policy rather than a join-backed one.
CREATE TYPE "public"."message_role" AS ENUM('USER', 'ASSISTANT');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"grounding_bundle" jsonb,
	"model_version" text,
	"prompt_version" text,
	"catalog_version" text,
	"validation_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- RLS matches every other tenant table's exact pattern — FORCE so even the table owner can't
-- bypass it, a real tenant-scoped predicate on organization_id, not a join-derived check.
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messages"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
-- A conversation's transcript reads chronologically; scoped by (organization_id, conversation_id)
-- matching every other tenant-first index convention in this schema (I4: tenant column leads).
CREATE INDEX IF NOT EXISTS "messages_org_conversation_created_at_idx" ON "messages" ("organization_id", "conversation_id", "created_at");
--> statement-breakpoint
-- A user's own conversation list, most recent first — tenant-first, matching the index above.
CREATE INDEX IF NOT EXISTS "conversations_org_user_created_at_idx" ON "conversations" ("organization_id", "user_id", "created_at");
