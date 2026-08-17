import type { Job } from 'bullmq';
import { createDb, DocumentRepository, DocumentEmbeddingRepository } from '@retailos/db';
import { buildDocumentEmbeddingText, type ExtractedDocumentFields, type ExtractedDocumentLine } from '@retailos/domain';
import { embedText, type EmbeddingResult } from '@retailos/ai';
import type { EmbeddingJobData } from '@retailos/queue';

/**
 * 009-18 — the real worker-side handler for a document's embedding job. Builds the synthetic
 * descriptive text from the document's LATEST extraction (`buildDocumentEmbeddingText`,
 * `@retailos/domain`), embeds it via the real Gemini `embedContent` call
 * (`embedText`, `@retailos/ai`), and upserts the result — matching
 * `createFactAggregationProcessor`'s own "processor is a thin adapter, the real logic lives in a
 * plain function" shape.
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
    // 'POSTED' is included alongside 'APPROVED' — PostingService (007-11) can move a document
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
    if (sourceText.trim().length === 0) {
      // Nothing was ever extracted (every field genuinely null) — no real text exists to embed.
      return;
    }

    const embedding = await embed(config.geminiApiKey, sourceText);

    const embeddingRepository = new DocumentEmbeddingRepository(db, organizationId);
    await embeddingRepository.upsert({ documentId, model: embedding.model, sourceText, values: embedding.values });
  };
};
