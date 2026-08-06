import type { Job } from 'bullmq';
import { DocumentRepository, createDb } from '@retailos/db';
import { createCircuitBreakerExtractionProvider, createGeminiExtractionProvider, createTesseractExtractionProvider, type ExtractionProvider } from '@retailos/ai';
import { createStorageClient, getObjectBytes } from '@retailos/storage';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ExtractionJobData } from '@retailos/queue';

/**
 * 007-06 (plan.md Phase 2: "Primary + secondary configured. Circuit breaker; fall back on
 * outage."). 5 consecutive Gemini failures opens the circuit (routes straight to Tesseract without
 * even trying Gemini) for 5 minutes, then allows one real trial call. These numbers aren't from a
 * spec — they're a reasonable default for a free-tier provider with no documented SLA; revisit if
 * real production telemetry (007-14) ever shows them wrong.
 */
const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 007-05 (plan.md Phase 2): the real worker-side extraction job — downloads the document's actual
 * bytes, calls the real Gemini provider, and records the result via `DocumentRepository.
 * recordExtraction` (007-01's own method, built for exactly this, unused until now). A provider
 * error (`result.error` set) still produces a real `document_extractions` row — a failed attempt is
 * a genuine, useful data point (matching the spike's own "a failed extraction is a data point, not
 * a crash" convention), not something to silently drop.
 *
 * No validation gates exist yet (007-07) — every extraction, successful or not, moves the document
 * to `REVIEW_REQUIRED`, never `AUTO_APPROVED`. Auto-approval requires gates to justify it; without
 * them, treating every extraction as needing human review is the conservative, correct default
 * (plan.md Phase 4: "bias conservative"). `validation` is stored as a placeholder
 * `{ issues: [], canAutoApprove: false }` — real gate output replaces this wholesale in 007-07, not
 * incrementally; nothing here should be read as meaningful validation.
 */
export const createExtractionProcessor = (config: {
  databaseUrl: string;
  geminiApiKey: string | undefined;
  storage: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  /** Overridable for tests — production callers omit this and get the real Gemini provider. */
  provider?: ExtractionProvider;
}) => {
  const { db } = createDb(config.databaseUrl);
  const storageClient: S3Client = createStorageClient({
    endpoint: config.storage.endpoint,
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
    bucket: config.storage.bucket,
  });
  const provider =
    config.provider ??
    (config.geminiApiKey
      ? createCircuitBreakerExtractionProvider(createGeminiExtractionProvider(config.geminiApiKey), createTesseractExtractionProvider(), {
          failureThreshold: FAILURE_THRESHOLD,
          resetTimeoutMs: RESET_TIMEOUT_MS,
        })
      : null);

  return async (job: Job<ExtractionJobData>): Promise<void> => {
    const { documentId, organizationId, storageKey, mimeType } = job.data;
    const documentRepository = new DocumentRepository(db, organizationId);

    await documentRepository.updateStatus(documentId, 'PROCESSING');

    if (!provider) {
      // No key configured on this worker (e.g. CI, a fresh clone) — the job is not attempted,
      // never a fabricated extraction. Left at PROCESSING rather than moved to REVIEW_REQUIRED,
      // since no real extraction attempt happened to review.
      return;
    }

    const bytes = await getObjectBytes(storageClient, config.storage.bucket, storageKey);
    const result = await provider.extract(bytes, mimeType);

    // `document_extractions.fields`/`.lines` are NOT NULL — a provider error genuinely ran an
    // extraction attempt (unlike the no-provider-configured case above, which never attempts one
    // at all), so it gets a real row, just with empty structures rather than `null`, honestly
    // representing "this run happened, extracted nothing" (distinct from `null`, which would read
    // as "never asked"). The real error is recorded in `validation.issues`, not silently absorbed —
    // 007-07 will teach `validation` to mean something more, but even this placeholder shape must
    // not hide a genuine provider failure.
    await documentRepository.recordExtraction({
      documentId,
      provider: result.provider,
      modelVersion: result.modelVersion,
      promptVersion: '1',
      fields: result.fields ?? {},
      lines: result.lines ?? [],
      validation: result.error
        ? { issues: [{ severity: 'BLOCK', code: 'EXTRACTION_FAILED', message: result.error }], canAutoApprove: false }
        : { issues: [], canAutoApprove: false },
      ...(result.overallConfidence !== null ? { overallConfidence: result.overallConfidence.toFixed(4) } : {}),
    });

    await documentRepository.updateStatus(documentId, 'REVIEW_REQUIRED');
  };
};
