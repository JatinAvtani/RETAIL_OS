import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { generateId } from '@retailos/domain';
import { computeExtractionAutoApprovalRate, computeValidationIssueFrequency } from '@retailos/metrics';
import { DocumentRepository, PostingService, StoreRepository, SupplierProductRepository, SupplierRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { classifyDocument } from '@retailos/ai';
import { enqueueExtractionJob } from '@retailos/queue';
import {
  buildDocumentKey,
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
  documentFormatToMimeType,
  ensureBucketExists,
  getObjectBytes,
  validateDocumentUpload,
} from '@retailos/storage';
import { protectedProcedure, router } from '../trpc';
import { storageClient, DOCUMENTS_BUCKET, extractionQueue } from '../context';

const requestUploadInput = z.object({ storeId: z.string().uuid() });
const confirmUploadInput = z.object({ storeId: z.string().uuid(), key: z.string() });
const getDocumentInput = z.object({ documentId: z.string().uuid() });
const listInput = z.object({ storeId: z.string().uuid() });
const searchInput = z.object({
  storeId: z.string().uuid(),
  status: z.enum(['UPLOADED', 'PROCESSING', 'REVIEW_REQUIRED', 'AUTO_APPROVED', 'APPROVED', 'REJECTED', 'POSTED']).optional(),
  type: z.enum(['INVOICE', 'DELIVERY_NOTE', 'CREDIT_NOTE', 'QUOTE', 'CONTRACT', 'CERTIFICATE', 'OTHER']).optional(),
  query: z.string().trim().max(200).optional(),
});
const reviewDecisionInput = z.object({ documentId: z.string().uuid() });
const rejectInput = z.object({ documentId: z.string().uuid(), reason: z.string().trim().min(1).max(1000).optional() });
const confirmLineMappingInput = z.object({
  documentId: z.string().uuid(),
  lineIndex: z.number().int().min(0),
  productId: z.string().uuid(),
});
const accuracyTelemetryInput = z.object({
  days: z.number().int().min(1).max(365).default(30),
});

/** 007-09: `documents:approve` gates the review decision itself; `documents:read` gates seeing the review surface at all — matches spec 04 §4.8's matrix (Accountant/VIEWER_FINANCE can view, never approve). Same plain-array-check shape `invitations.ts` already established for `users:manage`, since no endpoint has needed a full `packages/authz` `AuthContext` yet. */
const requirePermission = (permissions: string[], permission: string) => {
  if (!permissions.includes(permission)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  }
};

/** Idempotent, same shape as `products.ts`'s/`csv-import.ts`'s own `ensureBucketOnce` — a separate bucket needing its own one-time creation. */
let bucketEnsured = false;
const ensureBucketOnce = async () => {
  if (bucketEnsured) return;
  await ensureBucketExists(storageClient, DOCUMENTS_BUCKET);
  bucketEnsured = true;
};

/**
 * 007-04: classifies a freshly uploaded document synchronously, inside `confirmUpload`, using the
 * real Gemini vision call — confirmed with the user given classification is lighter-weight than
 * full extraction (007-05/06, which plan.md scopes to async/BullMQ specifically because of the
 * spike's measured 20-220s free-tier latency). No `GEMINI_API_KEY` (e.g. CI, a fresh local clone) is
 * "classification not attempted", not a guessed type — `confirmUpload` still succeeds with the
 * document left at `create`'s own `'OTHER'` default, matching how this endpoint already behaved
 * before 007-04 existed. A real provider error is treated the same way: the document is not
 * rejected over a classification failure, since upload succeeding is the load-bearing outcome here,
 * not classification.
 */
const classifyUploadedDocument = async (
  bytes: Buffer,
  mimeType: string
): Promise<{ type: Awaited<ReturnType<typeof classifyDocument>>['type']; confidence: string } | null> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const result = await classifyDocument(apiKey, bytes, mimeType);
  return { type: result.type, confidence: result.confidence.toFixed(4) };
};

/**
 * 007-02 (plan.md Phase 1): upload -> verify real bytes -> record. Same two-step presigned-upload
 * shape as `products.requestImageUpload`/`csvImport.requestUpload` (spec 14 §14.3/§14.7: presigned
 * URL, never proxied through the API; bytes verified server-side after upload, never trusted from
 * the client's declared content-type). `requestUpload` never touches `documents` and never mints a
 * real document id — the row is created ONLY at `confirmUpload`, once the actual uploaded bytes
 * have been downloaded, verified, and hashed.
 *
 * Malware/AV scanning is deliberately out of scope (matches 004-12's product-image precedent — no
 * card, no budget for a real scanning service); magic-byte format verification + a size cap are the
 * real mitigations here. XXE/PDF-bomb hardening (spec 14 §14.7) applies to PARSING a PDF's internal
 * structure, which this task never does — that belongs to 007-05/06 (extraction), not upload.
 */
export const documentsRouter = router({
  requestUpload: protectedProcedure.input(requestUploadInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }
    await ensureBucketOnce();

    // The final key needs the verified extension, unknown until confirmUpload — upload to a
    // provisional key under a fresh random id, matching csvImport's own "key minted before any row
    // exists" shape. The extension is irrelevant to S3 (a presigned PUT just needs a key), so a
    // neutral placeholder here does not implicitly trust the client's claimed type.
    const key = buildDocumentKey(ctx.session.organizationId, randomUUID(), 'upload');
    const uploadUrl = await createPresignedUploadUrl(storageClient, DOCUMENTS_BUCKET, key, 'application/octet-stream');

    return { uploadUrl, key };
  }),

  /** Downloads and verifies the just-uploaded bytes (real magic-byte format, size cap), hashes them for future duplicate detection (007-07's job to act on), and creates the real `documents` row. */
  confirmUpload: protectedProcedure.input(confirmUploadInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    if (!input.key.startsWith(`org/${ctx.session.organizationId}/`)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Upload key does not belong to this organization.' });
    }

    const bytes = await getObjectBytes(storageClient, DOCUMENTS_BUCKET, input.key);
    const validation = validateDocumentUpload(bytes);
    if (!validation.valid) {
      const messages: Record<typeof validation.reason, string> = {
        TOO_LARGE: 'Uploaded file exceeds the maximum allowed size.',
        UNSUPPORTED_FORMAT: 'Uploaded file must be a PDF, JPEG, or PNG.',
      };
      throw new TRPCError({ code: 'BAD_REQUEST', message: messages[validation.reason] });
    }

    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const mimeType = documentFormatToMimeType[validation.format];

    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const created = await documentRepository.create({
      storeId: input.storeId,
      source: 'UPLOAD',
      storageKey: input.key,
      contentHash,
      mimeType,
      sizeBytes: bytes.length,
      uploadedByUserId: ctx.session.userId,
    });

    const classification = await classifyUploadedDocument(bytes, mimeType);
    if (classification) {
      await documentRepository.updateClassification(created.id, classification.type, classification.confidence);
    }

    // 007-05: enqueue extraction — real, async (BullMQ), never synchronous like classification,
    // since the spike measured 20-220s Gemini latency for a full extraction call. `jobId:
    // documentId` (set inside enqueueExtractionJob) makes a retried confirmUpload call idempotent
    // rather than double-enqueuing the same document.
    await enqueueExtractionJob(extractionQueue, {
      documentId: created.id,
      organizationId: ctx.session.organizationId,
      storageKey: input.key,
      mimeType,
    });

    return { documentId: created.id, format: validation.format, type: classification?.type ?? 'OTHER' };
  }),

  get: protectedProcedure.input(getDocumentInput).query(async ({ ctx, input }) => {
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const document = await documentRepository.findById(input.documentId);
    if (!document) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }
    return document;
  }),

  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    return documentRepository.listForStore(input.storeId);
  }),

  /**
   * 007-13: the real list/search/filter view. `status`/`type` are real column filters; `query`
   * matches the latest extraction's supplier name or document number (extracted free text, not a
   * real column — same JSONB-read approach 007-07's duplicate gate already established). A
   * document with no extraction yet simply can't match a text query, honestly (I7).
   */
  search: protectedProcedure.input(searchInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    return documentRepository.search(input.storeId, {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.query !== undefined && { query: input.query }),
    });
  }),

  /**
   * 007-09: everything the review screen needs in one call — the document row, its latest
   * extraction (fields/lines/confidence/validation issues), and a fresh presigned GET url for the
   * original file (never a public URL — spec 14 §14.7, every object stays private). `documents:read`
   * gates viewing at all (matches spec 04 §4.8: Accountant/VIEWER_FINANCE can view, Staff cannot).
   * The image url is generated fresh on every call rather than cached, since a presigned url expires
   * — the review screen may sit open for a while.
   */
  getForReview: protectedProcedure.input(getDocumentInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'documents:read');
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const document = await documentRepository.findById(input.documentId);
    if (!document || !canAccessStore(ctx.session, document.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }
    const extraction = await documentRepository.getLatestExtraction(input.documentId);
    const imageUrl = await createPresignedDownloadUrl(storageClient, DOCUMENTS_BUCKET, document.storageKey);
    return { document, extraction, imageUrl };
  }),

  /**
   * A human decision on a document already at `REVIEW_REQUIRED` or `AUTO_APPROVED` (plan.md §5.6.1:
   * an auto-approval is "still reviewable" — a human can override it). `documents:approve` is a
   * SEPARATE, stricter permission from `documents:read` (spec 04 §4.8: Accountant can view but never
   * approve). No field-editing/correction capture here — that is 007-10's explicit, separate scope
   * (confirmed with the user); this endpoint only records the approve/reject decision itself.
   */
  /**
   * 007-11 (plan.md Phase 6, "the transactional heart"): approving is not the end of the workflow
   * — spec 05 §5.6.1's pipeline reads `APPROVED → posting`. After the approve status transition
   * succeeds, `PostingService.postDocument` runs in its own single transaction (I3/I8): price
   * history, a real stock receipt (lot + RECEIPT movement, which recomputes `stock_levels`'
   * moving-average cost), and provenance links, for every line with a CONFIRMED supplier-SKU
   * mapping (007-10). A line with no mapping yet is skipped, not blocking (confirmed with the
   * user) — the document still reaches `POSTED`. If posting itself fails, the approve transition
   * has already committed (a real, if narrow, two-step gap — acceptable since approve failing
   * silently would be worse than a document stuck at APPROVED needing a retry, and this project has
   * no PurchaseOrder/GoodsReceipt/InvoiceMatch tables yet to make posting fail on THEIR account).
   */
  approve: protectedProcedure.input(reviewDecisionInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'documents:approve');
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const existing = await documentRepository.findById(input.documentId);
    if (!existing || !canAccessStore(ctx.session, existing.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }
    const updated = await documentRepository.approve(input.documentId, ctx.session.userId);
    if (!updated) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This document is not awaiting review.' });
    }

    const extraction = await documentRepository.getLatestExtraction(input.documentId);
    if (extraction) {
      const postingService = new PostingService(ctx.db, ctx.session.organizationId);
      await postingService.postDocument({
        documentId: input.documentId,
        storeId: updated.storeId,
        fields: extraction.fields as { supplier: { value: string | null } },
        lines: extraction.lines as { sku: { value: string | null }; quantity: { value: string | null }; unitPrice: { value: string | null }; lineTotal: { value: string | null } }[],
        actorUserId: ctx.session.userId,
      });
    }

    const posted = await documentRepository.findById(input.documentId);
    return posted ?? updated;
  }),

  reject: protectedProcedure.input(rejectInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'documents:approve');
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const existing = await documentRepository.findById(input.documentId);
    if (!existing || !canAccessStore(ctx.session, existing.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }
    const updated = await documentRepository.reject(input.documentId, ctx.session.userId, input.reason);
    if (!updated) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This document is not awaiting review.' });
    }
    return updated;
  }),

  /**
   * 007-10 (plan.md Phase 5): "correction capture → supplier-SKU mapping table." A reviewer maps
   * one extraction line's SKU to a real product — the mapping becomes a PERMANENT
   * `supplier_products` row (`isConfirmed: true`), applied with certainty to every future invoice
   * from this supplier carrying this exact SKU (no ML auto-mapping, per plan.md's own stated
   * design principle: a wrong auto-mapping silently corrupts cost for months). Requires
   * `documents:approve` — mapping a supplier's product is a cost-affecting decision, the same
   * permission tier as approving the document itself, not merely viewing it (`documents:read`).
   *
   * The extracted supplier name must ALREADY resolve to a real `suppliers` row (exact,
   * case-insensitive match, same resolution 007-07's validation gate uses) — this endpoint does
   * not guess or fuzzy-match a supplier; if none exists yet, the reviewer creates one first via
   * `suppliers.create` (a genuinely new supplier on a first invoice is routine, not an error).
   *
   * If a mapping for this exact (supplier, SKU) pair already exists (e.g. an earlier document
   * created an unconfirmed one, or this line was already mapped), it is CONFIRMED in place rather
   * than duplicated — the real DB unique index on `(organization_id, supplier_id, supplier_sku)`
   * would reject a duplicate insert anyway, but checking first gives a clean, expected behavior
   * (idempotent re-confirmation) instead of a raw constraint-violation error.
   */
  confirmLineMapping: protectedProcedure.input(confirmLineMappingInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'documents:approve');
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const document = await documentRepository.findById(input.documentId);
    if (!document || !canAccessStore(ctx.session, document.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    const extraction = await documentRepository.getLatestExtraction(input.documentId);
    if (!extraction) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This document has no extraction to correct.' });
    }
    const fields = extraction.fields as { supplier?: { value: string | null } } | null;
    const lines = extraction.lines as { sku?: { value: string | null } }[] | null;
    const supplierName = fields?.supplier?.value;
    const line = lines?.[input.lineIndex];
    if (!supplierName || !line) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This document has no supplier or line at that index to map.' });
    }
    const sku = line.sku?.value;
    if (!sku) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This line has no extracted SKU to map.' });
    }

    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const supplier = await supplierRepository.findByExactName(supplierName);
    if (!supplier) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `No supplier named "${supplierName}" exists yet — create it first.`,
      });
    }

    const supplierProductRepository = new SupplierProductRepository(ctx.db, ctx.session.organizationId);
    const existingMapping = await supplierProductRepository.findBySupplierAndSku(supplier.id, sku);
    const mapping = existingMapping
      ? (existingMapping.isConfirmed ? existingMapping : await supplierProductRepository.confirm(existingMapping.id))
      : await (async () => {
          const created = await supplierProductRepository.create({
            id: generateId(),
            supplierId: supplier.id,
            productId: input.productId,
            supplierSku: sku,
          });
          return supplierProductRepository.confirm(created.id);
        })();

    if (!mapping) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to confirm the supplier-product mapping.' });
    }

    await documentRepository.recordCorrection({
      extractionId: extraction.id,
      fieldPath: `lines[${input.lineIndex}].sku`,
      originalValue: sku,
      correctedValue: { supplierProductId: mapping.id, productId: mapping.productId },
      correctedByUserId: ctx.session.userId,
    });

    return mapping;
  }),

  /**
   * 007-12 (plan.md: "provenance links — document -> every number it produced"). Reads the real
   * `document_links` rows 007-11's `PostingService` writes — the forward drill-through direction
   * (spec 07 §7.6: "enables drill-through from any number to its source" is symmetric, but this
   * query is the document's own view of what it produced, matching the review page's own layout).
   * `documents:read` gates this the same as `getForReview` — provenance is part of viewing a
   * document, not a separate, stricter capability.
   */
  getLinks: protectedProcedure.input(getDocumentInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'documents:read');
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const document = await documentRepository.findById(input.documentId);
    if (!document || !canAccessStore(ctx.session, document.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }
    return documentRepository.findLinksForDocument(input.documentId);
  }),

  /**
   * 007-14 (spec 12 §12.2's `extraction_auto_approval_rate`, plan.md: "measures whether the
   * pipeline saves labor"). Org-wide (not store-scoped — matches `integrations.health`'s own
   * 006-13 precedent that health/accuracy telemetry is a tenant-level view), no `*Id`-shaped input,
   * so correctly NOT registered in the cross-tenant registry — its own dedicated cross-tenant test
   * covers the real risk directly (a different org's session sees only ITS OWN extractions).
   * `documents:read` gates it — viewing pipeline health is not a stricter capability than viewing
   * a document.
   */
  accuracyTelemetry: protectedProcedure.input(accuracyTelemetryInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'documents:read');
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
    const extractions = await documentRepository.listExtractionsSince(since);

    const autoApprovalRate = computeExtractionAutoApprovalRate(
      extractions.map((e) => {
        const validation = e.validation as { canAutoApprove: boolean };
        return {
          canAutoApprove: validation.canAutoApprove,
          overallConfidence: e.overallConfidence !== null ? Number(e.overallConfidence) : null,
          fieldConfidences: collectFieldConfidences(e.fields as ExtractedFieldsShape | null, e.lines as ExtractedFieldsShape[] | null),
        };
      })
    );

    const issueFrequency = computeValidationIssueFrequency(
      extractions.map((e) => e.validation as { issues: { code: string; severity: 'BLOCK' | 'WARN' }[] })
    );

    return {
      period: { days: input.days, since: since.toISOString() },
      documentCount: extractions.length,
      autoApprovalRate,
      issueFrequency,
    };
  }),
});

type ExtractedFieldsShape = Record<string, { confidence: number | null }>;

/** Mirrors `apps/worker/src/extraction-processor.ts`'s own `collectFieldConfidences` exactly — every scored field across the document header and every line. */
const collectFieldConfidences = (fields: ExtractedFieldsShape | null, lines: ExtractedFieldsShape[] | null): (number | null)[] => {
  if (fields === null) return [];
  const headerConfidences = Object.values(fields).map((field) => field.confidence);
  const lineConfidences = (lines ?? []).flatMap((line) => Object.values(line).map((field) => field.confidence));
  return [...headerConfidences, ...lineConfidences];
};
