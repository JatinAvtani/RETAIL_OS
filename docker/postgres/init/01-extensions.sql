-- Extensions RetailOS depends on directly (spec 08 SS8.1, SS8.2):
--   pgcrypto  -- gen_random_uuid() for UUID v7-style primary keys
--   pg_trgm   -- fuzzy/trigram search, chosen over Elasticsearch specifically because RLS applies
--   vector    -- pgvector, embeddings share the same tenant-isolated database (no sync pipeline)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
