-- Hand-written. Follow-up to migration 0039 (already applied) — 009-01's own design was refined
-- mid-task after confirming with the user that fact_daily_consumption.theoreticalCogs (a real
-- STORE-WIDE dollar figure, no per-ingredient breakdown available — see
-- packages/db/src/schema/fact-tables.ts's own header) needed a dedicated sentinel row per
-- (org, store, date) rather than being repeated on every real per-product row, which would let a
-- naive per-product SUM silently double/triple-count it. `product_id`/`variant_id`/`actual_qty`
-- become nullable so that sentinel row (product_id/variant_id both NULL, actual_qty/actual_cogs
-- both NULL) is representable at all — a real "not applicable" fact for that one row, not a zero.
ALTER TABLE "fact_daily_consumption" ALTER COLUMN "product_id" DROP NOT NULL;
ALTER TABLE "fact_daily_consumption" ALTER COLUMN "variant_id" DROP NOT NULL;
ALTER TABLE "fact_daily_consumption" ALTER COLUMN "actual_qty" DROP NOT NULL;
--> statement-breakpoint

-- The original unique index (organization_id, store_id, date, product_id, variant_id) still works
-- for the sentinel row too: Postgres unique indexes treat NULL as distinct from NULL by default,
-- so multiple (org, store, date, NULL, NULL) sentinel rows would NOT violate the existing index —
-- exactly wrong, since there must be at most ONE sentinel per (org, store, date). Replaced with a
-- COALESCE-based index, the same technique `fact_daily_sales_grain_unique` (migration 0039)
-- already established for its own nullable grain columns.
DROP INDEX IF EXISTS "fact_daily_consumption_grain_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "fact_daily_consumption_grain_unique" ON "fact_daily_consumption" (
  "organization_id", "store_id", "date",
  COALESCE("product_id", '00000000-0000-0000-0000-000000000000'),
  COALESCE("variant_id", '00000000-0000-0000-0000-000000000000')
);
