-- Semantic search over documents — the vector half of
-- search. One row per document, embedding a synthetic
-- descriptive text assembled from the document's ALREADY-APPROVED extracted fields (supplier,
-- document number, date, line-item descriptions, total) — no raw OCR text
-- is persisted anywhere in this schema today (Gemini's extraction path never produces one; Tesseract's
-- is computed then discarded), so this is the real, honest corpus available: an "entity descriptions"
-- corpus, not literal OCR full-text (which would need a real, separate
-- schema change this task doesn't make).
--
-- gemini-embedding-001 (Google's free-tier embedding model, same GEMINI_API_KEY already used for
-- extraction/classification; text-embedding-004 was tried first but turned out unavailable for this
-- key via a real live call) defaults to 3072 dimensions; outputDimensionality truncates it to 768
-- at call time (packages/ai/src/embedding-provider.ts), matching this column.
CREATE TABLE IF NOT EXISTS "document_embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"model" text NOT NULL,
	"source_text" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_embeddings_document_id_unique" UNIQUE("document_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_embeddings" ADD CONSTRAINT "document_embeddings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_embeddings" ADD CONSTRAINT "document_embeddings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- RLS matches every other tenant table's exact pattern (e.g. supplier_performance_events,
-- migration 0038) — FORCE so even the table owner can't bypass it, a real tenant-scoped predicate
-- on organization_id, not a join-derived check.
ALTER TABLE "document_embeddings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_embeddings"
  USING ("organization_id" = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint
-- HNSW over cosine distance (Google's own embedding docs recommend cosine similarity for
-- text-embedding-004) — chosen explicitly as the vector-index method.
CREATE INDEX IF NOT EXISTS "document_embeddings_hnsw_idx" ON "document_embeddings" USING hnsw ("embedding" vector_cosine_ops);
