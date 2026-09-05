-- Second batch of compound tenant-aware foreign keys, extending migration 0054's same reasoning to
-- 3 more cross-tenant-reachable pairs. A 4th candidate (recipe_components -> products) was
-- evaluated and deliberately NOT included here: recipe_components has no organization_id column at
-- all (tenancy there is enforced only indirectly, via RLS subquerying through recipes.organization_id),
-- so this pattern cannot be applied without first denormalizing a new column onto that table — a
-- separate, larger migration with its own backfill, not a one-line addition alongside these three.
--
-- Verified zero existing violations for all three pairs before writing this migration (a direct
-- query joining each child to its parent on the existing single-column FK and comparing
-- organization_id, run against the real dev database).

-- ── purchase_order_lines -> supplier_products ───────────────────────────────
ALTER TABLE "supplier_products"
  ADD CONSTRAINT "supplier_products_org_id_unique" UNIQUE ("organization_id", "id");

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_supplier_product_org_fk"
  FOREIGN KEY ("organization_id", "supplier_product_id")
  REFERENCES "supplier_products" ("organization_id", "id");

-- ── invoice_match_lines -> products ──────────────────────────────────────────
-- `invoice_match_lines.product_id` is nullable by design — an invoice line with no confirmed
-- product match at all (the "unordered item"/"invoiced but never received" variance cases) is a
-- real, recordable fact (I7), not an error. Postgres's own standard MATCH SIMPLE FK semantics skip
-- the check when any referencing column is NULL, so this tolerates that case exactly as the plain
-- single-column FK already did — the same reasoning migration 0054 already used for
-- `products.category_id`.
ALTER TABLE "invoice_match_lines"
  ADD CONSTRAINT "invoice_match_lines_product_org_fk"
  FOREIGN KEY ("organization_id", "product_id")
  REFERENCES "products" ("organization_id", "id");

-- ── stock_movements -> lots ──────────────────────────────────────────────────
-- `stock_movements.lot_id` is nullable (not every movement type draws from a tracked lot — a plain
-- stocktake adjustment or a movement predating lot tracking can have none). Same NULL-skips-the-
-- check reasoning as above.
ALTER TABLE "lots"
  ADD CONSTRAINT "lots_org_id_unique" UNIQUE ("organization_id", "id");

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_lot_org_fk"
  FOREIGN KEY ("organization_id", "lot_id")
  REFERENCES "lots" ("organization_id", "id");
