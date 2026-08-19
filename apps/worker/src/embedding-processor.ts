import type { Job } from 'bullmq';
import { createDb, DocumentRepository, DocumentEmbeddingRepository, DocumentChunkEmbeddingRepository } from '@retailos/db';
import { buildDocumentEmbeddingText, chunkDocument, type ExtractedDocumentFields, type ExtractedDocumentLine, type ExtractedFields, type ExtractedLine } from '@retailos/domain';
import { embedText, type EmbeddingResult } from '@retailos/ai';
import type { EmbeddingJobData } from '@retailos/queue';

/**
 * the real worker-side handler for a document's embedding job. Builds the synthetic
 * descriptive text from the document's LATEST extraction (`buildDocumentEmbeddingText`,
 * `@retailos/domain`), embeds it via the real Gemini `embedContent` call
 * (`embedText`, `@retailos/ai`), and upserts the result — matching
 * `createFactAggregationProcessor`'s own "processor is a thin adapter, the real logic lives in a
 * plain function" shape.
 *
 * **This SAME job also writes per-chunk embeddings** (`chunkDocument`,
 * `@retailos/domain`), rather than a new queue/worker/trigger — confirmed via a real search that
 * `documents.approve` is the ONLY real place `enqueueEmbeddingJob` fires from, so a document
 * reaching `APPROVED` is already the exact, single, correct trigger both the whole-document
 * embedding (for `search.documents`' document-list UI) and the chunk embeddings (built later,
 * for the assistant's retrieval passages) need — two consumers of the same real event, not two
 * separate pipelines to keep in sync. A chunk-embedding failure (a single `embedText` call
 * throwing) does not abort the whole-document embedding or vice versa — each is independently
 * best-effort, matching this job's own established "a document without an embedding row is just
 * not in the semantic index, never a fabricated zero vector" tolerance.
 *
 * Genuinely skips (no throw, no retry) rather than fails when there's nothing real to embed yet: a
 * document with no extraction at all, or one that's since moved OFF `APPROVED` (e.g. corrected
 * back to `REVIEW_REQUIRED`) between enqueue and processing — an embedding built from stale or
 * absent data would be worse than no embedding at all (I7's reasoning applied to a search index,
 * not a business number).
 */
export const createEmbeddingProcessor = (config: {
  databaseUrl: string;
  geminiApiKey: string | undefined;
  /** Overridable for tests — production callers omit this and get the real Gemini `embedText` call. */
  embedFn?: (apiKey: string, text: string) => Promise<EmbeddingResult>;
}) => {
  const { db } = createDb(config.databaseUrl);
  const embed = config.embedFn ?? embedText;

  return async (job: Job<EmbeddingJobData>): Promise<void> => {
    const { organizationId, documentId } = job.data;

    if (!config.geminiApiKey) {
      // No key configured on this worker (e.g. CI, a fresh clone) — matching
      // createExtractionProcessor's identical no-key convention: the job is not attempted, never a
      // fabricated embedding.
      return;
    }

    const documentRepository = new DocumentRepository(db, organizationId);
    const document = await documentRepository.findById(documentId);
    // 'POSTED' is included alongside 'APPROVED' — PostingService can move a document
    // from APPROVED to POSTED between this job's enqueue and processing; its extracted fields are
    // identical either way, so a document that's since posted is still real, trustworthy content.
    if (!document || (document.status !== 'APPROVED' && document.status !== 'POSTED')) {
      return;
    }

    const extraction = await documentRepository.getLatestExtraction(documentId);
    if (!extraction) {
      return;
    }

    const sourceText = buildDocumentEmbeddingText(
      extraction.fields as ExtractedDocumentFields,
      (extraction.lines as ExtractedDocumentLine[]) ?? []
    );
    if (sourceText.trim().length > 0) {
      const embedding = await embed(config.geminiApiKey, sourceText);
      const embeddingRepository = new DocumentEmbeddingRepository(db, organizationId);
      await embeddingRepository.upsert({ documentId, model: embedding.model, sourceText, values: embedding.values });
    }

    const chunks = chunkDocument(extraction.fields as ExtractedFields, (extraction.lines as ExtractedLine[]) ?? []);
    if (chunks.length > 0) {
      // Each chunk's embed call is independently fault-tolerant — one bad chunk (a transient
      // provider error) must not discard every OTHER chunk that embedded successfully; a
      // document with 9 of 10 real chunk embeddings is strictly more useful to retrieval than
      // zero, matching upsertChunks' own "the caller decides the full set to write" contract.
      const embeddedChunks: { chunkKey: string; chunkType: 'header' | 'line_item'; order: number; model: string; sourceText: string; values: number[] }[] = [];
      for (const chunk of chunks) {
        try {
          const embedding = await embed(config.geminiApiKey!, chunk.text);
          embeddedChunks.push({ chunkKey: chunk.chunkKey, chunkType: chunk.chunkType, order: chunk.order, model: embedding.model, sourceText: chunk.text, values: embedding.values });
        } catch {
          // A real provider failure for this one chunk — skip it, never a fabricated embedding.
        }
      }
      if (embeddedChunks.length > 0) {
        const chunkRepository = new DocumentChunkEmbeddingRepository(db, organizationId);
        await chunkRepository.upsertChunks(documentId, embeddedChunks);
      }
    }
  };
};
