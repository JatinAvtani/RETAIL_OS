-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- The ledger (spec 07 SS7.4, spec 08 SS8.6): the single factual record of everything that
-- happened to stock. Append-only, partitioned by occurred_at (business time), bi-temporal
-- against recorded_at (system time).
CREATE TYPE "public"."movement_type" AS ENUM(
  'RECEIPT', 'SALE_CONSUMPTION', 'WASTE', 'TRANSFER_OUT', 'TRANSFER_IN',
  'COUNT_ADJUSTMENT', 'PRODUCTION_INPUT', 'PRODUCTION_OUTPUT', 'RETURN_TO_SUPPLIER'
);
--> statement-breakpoint

-- A partitioned table's primary key (and every unique index on it) must include the partition
-- key column — Postgres cannot otherwise guarantee uniqueness across partitions. `id` alone
-- cannot be the PK here, unlike every other table in this codebase; (id, occurred_at) is.
-- `lot_id` has no FK yet — `lots` (005-02) doesn't exist. Same deferred-FK pattern as
-- unit_conversions.product_id before products existed: the column exists now so the ledger
-- schema doesn't need a later ALTER TABLE, the constraint is added once lots exists.
CREATE TABLE IF NOT EXISTS "stock_movements" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"lot_id" uuid,
	"movement_type" "movement_type" NOT NULL,
	"quantity" numeric(19, 6) NOT NULL,
	"unit_cost" numeric(19, 4),
	"currency" char(3) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"idempotency_key" text,
	"actor_user_id" uuid,
	"reason_code" text,
	"notes" text,
	PRIMARY KEY ("id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint

-- One real partition for the current month, plus a DEFAULT catch-all so an insert with an
-- occurred_at outside the pre-created range fails loudly at the database only if DEFAULT is
-- also absent — with DEFAULT present it is accepted, not silently rejected, matching plan.md's
-- "partitions created ahead of time" as an operational job this migration seeds the first
-- instance of, not a promise every future month is pre-created by this file alone.
CREATE TABLE IF NOT EXISTS "stock_movements_2026_08"
  PARTITION OF "stock_movements"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_movements_default"
  PARTITION OF "stock_movements" DEFAULT;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- I3, enforced by the database, not application discipline: no UPDATE or DELETE, ever.
-- Corrections are new compensating rows. Same two-step (PUBLIC then retailos_app) as audit_logs,
-- since ALTER DEFAULT PRIVILEGES grants retailos_app UPDATE/DELETE directly, not via PUBLIC.
REVOKE UPDATE, DELETE ON "stock_movements" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retailos_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "stock_movements" FROM retailos_app';
  END IF;
END
$$;
--> statement-breakpoint

-- Spec 08 SS8.7: write-heavy tables get a deliberately minimal index set — every index is a
-- write cost on the hottest path in the system. BRIN (not B-tree) for occurred_at, per SS8.7
-- point 4: orders of magnitude smaller than B-tree for naturally time-ordered append-only data.
-- The idempotency unique index must include occurred_at (the partition key) — Postgres requires
-- every unique index on a partitioned table to include it. Not CONCURRENTLY: Postgres refuses
-- CONCURRENTLY directly on a partitioned parent (no way to build one global concurrent index
-- across partitions) — a plain CREATE INDEX here is safe since every partition is empty now.
CREATE INDEX IF NOT EXISTS "stock_movements_org_store_product_idx" ON "stock_movements" ("organization_id", "store_id", "product_id", "variant_id");
CREATE INDEX IF NOT EXISTS "stock_movements_occurred_at_brin_idx" ON "stock_movements" USING brin ("occurred_at");
CREATE UNIQUE INDEX IF NOT EXISTS "stock_movements_idempotency_unique" ON "stock_movements" ("organization_id", "idempotency_key", "occurred_at") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint

-- RLS: directly org-scoped, same shape as every other tenant table. Partitioned tables inherit
-- RLS policies from the parent automatically — no per-partition policy needed.
ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_movements"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
