import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { DocumentRepository, StoreRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { classifyDocument } from '@retailos/ai';
import {
  buildDocumentKey,
  createPresignedUploadUrl,
  documentFormatToMimeType,
  ensureBucketExists,
  getObjectBytes,
  validateDocumentUpload,
} from '@retailos/storage';
import { protectedProcedure, router } from '../trpc';
import { storageClient, DOCUMENTS_BUCKET } from '../context';

const requestUploadInput = z.object({ storeId: z.string().uuid() });
const confirmUploadInput = z.object({ storeId: z.string().uuid(), key: z.string() });
const getDocumentInput = z.object({ documentId: z.string().uuid() });
const listInput = z.object({ storeId: z.string().uuid() });

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
});
