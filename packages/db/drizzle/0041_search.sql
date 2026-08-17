-- 009-17: spec 11 SS11.3. Lexical search infrastructure only (FTS + trigram) — the semantic/vector
-- half is 009-18's separate scope. pg_trgm/vector extensions are already enabled
-- (docker/postgres/init/01-extensions.sql); this migration is the first thing to actually USE them.
--
-- products/suppliers get a real GENERATED ALWAYS AS STORED tsvector column — Postgres keeps it in
-- sync on every write automatically, so there is no application-level sync-drift risk (the exact
-- property spec 11 SS11.2 calls out as the reason for choosing Postgres-native search at all).
-- purchase_orders is deliberately NOT given a generated tsvector — its only real free-text field is
-- po_number, a single short identifier better served by trigram similarity + exact match than FTS
-- tokenization.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("name", '')), 'A') || setweight(to_tsvector('english', coalesce("sku", '')), 'B')) STORED;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("name", ''))) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_search_vector_idx" ON "products" USING GIN ("search_vector");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_search_vector_idx" ON "suppliers" USING GIN ("search_vector");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_name_trgm_idx" ON "products" USING GIN ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_sku_trgm_idx" ON "products" USING GIN ("sku" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_name_trgm_idx" ON "suppliers" USING GIN ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_po_number_trgm_idx" ON "purchase_orders" USING GIN ("po_number" gin_trgm_ops);
