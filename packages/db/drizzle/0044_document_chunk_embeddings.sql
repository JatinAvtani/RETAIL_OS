-- Structure-aware chunking, deliberately a SEPARATE table from
-- document_embeddings (0042), not a replacement — that table serves search.documents' document-LIST
-- UI at whole-document granularity; this one serves the assistant's retrieval stage, which
-- needs chunk-granularity passages with real, citable snippet text ("never split a line item").
--
-- chunk_key ('header' or 'line-{index}', from chunkDocument, @retailos/domain) plus the UNIQUE
-- (document_id, chunk_key) index makes re-chunking a re-approved document idempotent by upsert
-- rather than delete-then-insert — an individually-corrected line gets its own chunk re-embedded,
-- not the whole document's chunk set torn down and rebuilt (real embedding-call cost under this
-- project's free-tier quota constraint, avoided where the data honestly allows it).
CREATE TYPE "document_chunk_type" AS ENUM ('header', 'line_item');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_chunk_embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_key" text NOT NULL,
	"chunk_type" "document_chunk_type" NOT NULL,
	"chunk_order" integer NOT NULL,
	"model" text NOT NULL,
	"source_text" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_chunk_embeddings_document_chunk_key_unique" UNIQUE("document_id","chunk_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_chunk_embeddings" ADD CONSTRAINT "document_chunk_embeddings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_chunk_embeddings" ADD CONSTRAINT "document_chunk_embeddings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- RLS matches document_embeddings' exact pattern (0042) — FORCE so even the table owner can't
-- bypass it, a real tenant-scoped predicate on organization_id.
ALTER TABLE "document_chunk_embeddings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_chunk_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_chunk_embeddings"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
-- HNSW over cosine distance, matching document_embeddings' own index — the design names
-- HNSW explicitly as the vector-index method for this table too.
CREATE INDEX IF NOT EXISTS "document_chunk_embeddings_hnsw_idx" ON "document_chunk_embeddings" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
-- The LEXICAL (BM25-equivalent, Postgres FTS) half of hybrid retrieval needs its own
-- generated tsvector column here, matching 0041_search.sql's exact GENERATED ALWAYS AS STORED
-- convention for products/suppliers — a chunk's own source_text is real, retrievable free text
-- (unlike products/suppliers, which only had a name/SKU to index), so no substring/trigram
-- fallback is needed the way DocumentRepository.search's jsonb-field LIKE pattern required.
ALTER TABLE "document_chunk_embeddings" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "source_text")) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunk_embeddings_search_vector_idx" ON "document_chunk_embeddings" USING GIN ("search_vector");
