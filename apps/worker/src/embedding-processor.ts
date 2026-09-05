import type { Job } from 'bullmq';
import { createDb, DocumentRepository, DocumentEmbeddingRepository, DocumentChunkEmbeddingRepository } from '@retailos/db';
import { buildDocumentEmbeddingText, chunkDocument, type ExtractedDocumentFields, type ExtractedDocumentLine, type ExtractedFields, type ExtractedLine } from '@retailos/domain';
import { embedText, EMBEDDING_MODEL, type EmbeddingResult } from '@retailos/ai';
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
      const chunkRepository = new DocumentChunkEmbeddingRepository(db, organizationId);
      // A cache keyed by chunkKey, populated from whatever chunk set (if any) is already stored for
      // this document — a retry after a transient failure, or a re-approval where only one line
      // item actually changed, re-chunks the WHOLE document identically for every unchanged chunk.
      // Comparing sourceText byte-for-byte against what's already embedded skips the real Gemini
      // call entirely for those, since embedding is a pure function of the text: identical input
      // text has already produced this exact output before, and re-calling the provider would only
      // reproduce it (modulo provider-side nondeterminism this codebase doesn't rely on for search
      // relevance) at real latency/cost. A model change invalidates the cache naturally — comparing
      // `model` too means a config change re-embeds everything, never silently keeps a stale vector
      // from a retired model version.
      const existingByChunkKey = await chunkRepository.findExistingByChunkKey(documentId);

      // Each chunk's embed call is independently attempted — one bad chunk (a transient provider
      // error) must not prevent every OTHER chunk from being embedded in this same pass. But
      // `upsertChunks` below is delete-then-insert-ALL (see its own doc comment) — a PARTIAL
      // failure would silently replace a complete prior chunk set with a smaller one, under-indexing
      // the document with no signal anywhere. So any failure here must fail the whole job, not just
      // skip the bad chunk: BullMQ's `attempts: 3` (embedding-queue.ts) then retries the full
      // document, which is idempotent (re-embeds everything not already cached) and can genuinely
      // succeed on retry for a transient provider error.
      const embeddedChunks: { chunkKey: string; chunkType: 'header' | 'line_item'; order: number; model: string; sourceText: string; values?: number[]; embeddingLiteral?: string }[] = [];
      const failedChunkKeys: string[] = [];
      let cacheHits = 0;
      for (const chunk of chunks) {
        const cached = existingByChunkKey.get(chunk.chunkKey);
        if (cached && cached.sourceText === chunk.text && cached.model === EMBEDDING_MODEL) {
          cacheHits += 1;
          embeddedChunks.push({ chunkKey: chunk.chunkKey, chunkType: chunk.chunkType, order: chunk.order, model: cached.model, sourceText: chunk.text, embeddingLiteral: cached.embeddingLiteral });
          continue;
        }
        try {
          const embedding = await embed(config.geminiApiKey!, chunk.text);
          embeddedChunks.push({ chunkKey: chunk.chunkKey, chunkType: chunk.chunkType, order: chunk.order, model: embedding.model, sourceText: chunk.text, values: embedding.values });
        } catch (error) {
          failedChunkKeys.push(chunk.chunkKey);
          console.error(`Embedding job: chunk ${chunk.chunkKey} failed for document ${documentId}`, error);
        }
      }
      if (cacheHits > 0) {
        console.log(`Embedding job: reused ${cacheHits}/${chunks.length} unchanged chunk embedding(s) for document ${documentId} — no provider call made for those.`);
      }
      if (failedChunkKeys.length > 0) {
        throw new Error(
          `Embedding job for document ${documentId}: ${failedChunkKeys.length}/${chunks.length} chunk(s) failed (${failedChunkKeys.join(', ')}) — not writing a partial chunk set.`
        );
      }
      if (embeddedChunks.length > 0) {
        await chunkRepository.upsertChunks(documentId, embeddedChunks);
      }
    }
  };
};
