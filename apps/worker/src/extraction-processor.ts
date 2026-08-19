import type { Job } from 'bullmq';
import { Decimal } from 'decimal.js';
import { DocumentRepository, SupplierPriceRepository, SupplierRepository, createDb } from '@retailos/db';
import { createCircuitBreakerExtractionProvider, createGeminiExtractionProvider, createTesseractExtractionProvider, type ExtractedFields, type ExtractedLine, type ExtractionProvider } from '@retailos/ai';
import { decideDocumentRouting, validateExtraction, type DuplicateCandidate, type RawFields, type RawLine, type TrailingPrice } from '@retailos/domain';
import { createStorageClient, getObjectBytes } from '@retailos/storage';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ExtractionJobData } from '@retailos/queue';

/**
 * earlier work (the plan Phase 2: "Primary + secondary configured. Circuit breaker; fall back on
 * outage."). 5 consecutive Gemini failures opens the circuit (routes straight to Tesseract without
 * even trying Gemini) for 5 minutes, then allows one real trial call. These numbers aren't from a
 * spec — they're a reasonable default for a free-tier provider with no documented SLA; revisit if
 * real production telemetry ever shows them wrong.
 */
const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * the real worker-side extraction job — downloads the document's actual
 * bytes, calls the real Gemini provider, and records the result via `DocumentRepository.
 * recordExtraction`. A provider
 * error (`result.error` set) still produces a real `document_extractions` row — a failed attempt is
 * a genuine, useful data point (matching the spike's own "a failed extraction is a data point, not
 * a crash" convention), not something to silently drop.
 *
 * `validation` is real gate output from `@retailos/domain`'s
 * `validateExtraction` — arithmetic reconciliation, duplicate detection, date plausibility, and
 * price-anomaly checks, all deterministic (I1: the model is never asked to verify its own numbers).
 *
 * the document's final status is `decideDocumentRouting`'s call —
 * `AUTO_APPROVED` only when every gate passes AND the overall confidence AND every present
 * per-field/line confidence clears the threshold; everything else (including a failed extraction,
 * which has no confidence at all) lands at `REVIEW_REQUIRED`.
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
    const supplierRepository = new SupplierRepository(db, organizationId);
    const supplierPriceRepository = new SupplierPriceRepository(db, organizationId);

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
    // as "never asked").
    const validation = result.error
      ? { issues: [{ severity: 'BLOCK' as const, code: 'EXTRACTION_FAILED', field: 'extraction', message: result.error }], canAutoApprove: false }
      : await runValidationGates(documentRepository, supplierRepository, supplierPriceRepository, documentId, result.fields, result.lines);

    await documentRepository.recordExtraction({
      documentId,
      provider: result.provider,
      modelVersion: result.modelVersion,
      promptVersion: '1',
      fields: result.fields ?? {},
      lines: result.lines ?? [],
      validation,
      ...(result.overallConfidence !== null ? { overallConfidence: result.overallConfidence.toFixed(4) } : {}),
    });

    const routing = decideDocumentRouting(validation.canAutoApprove, {
      overallConfidence: result.overallConfidence,
      fieldConfidences: collectFieldConfidences(result.fields, result.lines),
    });
    await documentRepository.updateStatus(documentId, routing);
  };
};

/** Every scored field across the document header and every line — the full population `decideDocumentRouting` requires to be entirely high-confidence. */
const collectFieldConfidences = (fields: ExtractedFields | null, lines: ExtractedLine[] | null): (number | null)[] => {
  if (fields === null) return [];
  const headerConfidences = Object.values(fields).map((field) => field.confidence);
  const lineConfidences = (lines ?? []).flatMap((line) => Object.values(line).map((field) => field.confidence));
  return [...headerConfidences, ...lineConfidences];
};

/**
 * Builds the real `ValidationContext` (duplicate candidates + confirmed trailing prices) and runs
 * `validateExtraction`. A `null` `fields`/`lines` (a successful provider call that genuinely found
 * nothing extractable) still gets a real gate run — an all-empty extraction naturally produces zero
 * issues, since every gate skips fields/lines it cannot parse, which is honest: "nothing to flag"
 * is not the same claim as "verified correct."
 */
const runValidationGates = async (
  documentRepository: DocumentRepository,
  supplierRepository: SupplierRepository,
  supplierPriceRepository: SupplierPriceRepository,
  documentId: string,
  fields: ExtractedFields | null,
  lines: ExtractedLine[] | null
) => {
  const rawFields = toRawFields(fields);
  const rawLines = (lines ?? []).map(toRawLine);

  const document = await documentRepository.findById(documentId);
  const duplicateCandidates: DuplicateCandidate[] = [];
  if (document) {
    const contentHashMatches = await documentRepository.findByContentHash(document.contentHash);
    for (const match of contentHashMatches) {
      if (match.id !== documentId) {
        duplicateCandidates.push({ documentId: match.id, matchedOn: 'CONTENT_HASH' });
        break; // one candidate is enough signal; the gate doesn't need every match
      }
    }
    if (rawFields.supplier.value !== null && rawFields.documentNumber.value !== null) {
      const supplierNumberMatches = await documentRepository.findBySupplierAndDocumentNumber(
        documentId,
        rawFields.supplier.value,
        rawFields.documentNumber.value
      );
      if (supplierNumberMatches.length > 0) {
        duplicateCandidates.push({ documentId: supplierNumberMatches[0]!.id, matchedOn: 'SUPPLIER_AND_DOCUMENT_NUMBER' });
      }
    }
  }

  const trailingPricesByLineIndex = new Map<number, TrailingPrice[]>();
  const supplierName = rawFields.supplier.value;
  const supplier = supplierName !== null ? await supplierRepository.findByExactName(supplierName) : null;
  if (supplier) {
    for (const [index, line] of rawLines.entries()) {
      if (line.sku.value === null) continue;
      const rows = await supplierPriceRepository.findConfirmedTrailingPricesBySupplierSku(supplier.id, line.sku.value);
      if (rows.length > 0) {
        trailingPricesByLineIndex.set(index, rows.map((row) => ({ unitPrice: new Decimal(row.unitPrice) })));
      }
    }
  }

  return validateExtraction(rawFields, rawLines, { duplicateCandidates, trailingPricesByLineIndex, today: new Date() });
};

const toRawFields = (fields: ExtractedFields | null): RawFields => ({
  supplier: { value: fields?.supplier.value ?? null },
  documentNumber: { value: fields?.documentNumber.value ?? null },
  documentDate: { value: fields?.documentDate.value ?? null },
  currency: { value: fields?.currency.value ?? null },
  subtotal: { value: fields?.subtotal.value ?? null },
  tax: { value: fields?.tax.value ?? null },
  discount: { value: fields?.discount.value ?? null },
  total: { value: fields?.total.value ?? null },
});

const toRawLine = (line: ExtractedLine): RawLine => ({
  sku: { value: line.sku.value },
  description: { value: line.description.value },
  quantity: { value: line.quantity.value },
  unit: { value: line.unit.value },
  unitPrice: { value: line.unitPrice.value },
  lineTotal: { value: line.lineTotal.value },
});
