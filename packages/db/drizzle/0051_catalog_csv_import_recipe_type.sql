-- Hand-written, not `drizzle-kit generate` output — this snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- Follow-up for recipe CSV import. `ALTER TYPE ... ADD VALUE` cannot run inside a transaction
-- block with other DDL in Postgres, so this is its own single-statement migration file — same
-- reasoning as every other enum-widening migration in this project. The TypeScript array literal
-- in packages/db/src/schema/catalog-csv-imports.ts is the sole source of the generated
-- CatalogCsvImportType union at compile time (Drizzle's pgEnum() does not read back the real
-- Postgres enum), so it was hand-edited to include 'RECIPE' in the same change as this migration.

ALTER TYPE "catalog_csv_import_type" ADD VALUE IF NOT EXISTS 'RECIPE';
