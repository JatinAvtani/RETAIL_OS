-- Extensions RetailOS depends on directly:
--   pgcrypto    -- gen_random_uuid() for UUID v7-style primary keys
--   pg_trgm     -- fuzzy/trigram search, chosen over Elasticsearch specifically because RLS applies
--   vector      -- pgvector, embeddings share the same tenant-isolated database (no sync pipeline)
--   btree_gist  -- lets a GiST exclusion constraint index a plain equality column (e.g. a uuid) in
--                  the same index as a range type. supplier_prices' effective-dating constraint
--                  (EXCLUDE USING gist (supplier_product_id WITH =, tstzrange(...) WITH &&)) needs
--                  this to index supplier_product_id's UUID equality at all — native GiST has no
--                  built-in operator class for uuid equality without it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;
