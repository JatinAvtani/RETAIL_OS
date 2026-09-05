-- Compound tenant-aware foreign keys for the three highest-risk cross-tenant reference pairs found
-- by an external audit: every FK in this schema was a plain single-column reference to a parent's
-- `id` (e.g. `goods_receipt_lines.product_id -> products.id`), with `organization_id` declared
-- separately alongside but never tied to the reference itself. RLS (I4) already blocks a
-- cross-organization READ or WRITE at the query layer today — this migration adds a second,
-- independent guarantee at the database layer itself: even a same-organization application bug that
-- somehow assembles an insert with a genuinely wrong (cross-org) child UUID is now physically
-- rejected by Postgres, not merely filtered out of a later read.
--
-- Verified zero existing violations for all three pairs before writing this migration (a direct
-- query joining each child to its parent on the FK and comparing organization_id, run against the
-- real dev database) — this is a real constraint being added to real, already-consistent data, not
-- a backfill that silently drops or nulls out any row.
--
-- Every parent table's `id` is already globally unique (its own primary key), so
-- `UNIQUE (organization_id, id)` is always safe to add on a parent — it can never conflict with an
-- existing constraint or reject an existing row; it only narrows what a REFERENCING child can point
-- at. Not applied project-wide: this targets the 3 pairs the audit specifically flagged as
-- realistically reachable by a same-org bug (a receipt line's product, a receipt's supplier, a
-- product's category) — the full table-by-table sweep remains a real, larger follow-up if ever
-- warranted, not attempted here as one big migration across every FK in the schema.

-- ── goods_receipt_lines -> products ─────────────────────────────────────────
ALTER TABLE "products"
  ADD CONSTRAINT "products_org_id_unique" UNIQUE ("organization_id", "id");

ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "goods_receipt_lines_product_org_fk"
  FOREIGN KEY ("organization_id", "product_id")
  REFERENCES "products" ("organization_id", "id");

-- ── goods_receipts -> suppliers ─────────────────────────────────────────────
ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_org_id_unique" UNIQUE ("organization_id", "id");

ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_supplier_org_fk"
  FOREIGN KEY ("organization_id", "supplier_id")
  REFERENCES "suppliers" ("organization_id", "id");

-- ── products -> categories ───────────────────────────────────────────────────
-- `products.category_id` is nullable, so this FK only ever applies to rows that HAVE a category —
-- Postgres's own standard MATCH SIMPLE FK semantics already skip the check when any referencing
-- column is NULL, exactly the same "no category assigned" case the plain single-column FK already
-- tolerated.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_org_id_unique" UNIQUE ("organization_id", "id");

ALTER TABLE "products"
  ADD CONSTRAINT "products_category_org_fk"
  FOREIGN KEY ("organization_id", "category_id")
  REFERENCES "categories" ("organization_id", "id");
