import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { StoreRepository, CsvImportRepository, SavedCsvMappingRepository } from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { buildCsvImportKey, createPresignedUploadUrl, ensureBucketExists, getObjectBytes, validateCsvUpload } from '@retailos/storage';
import { protectedProcedure, router } from '../trpc';
import { storageClient, SALES_CSV_IMPORTS_BUCKET } from '../context';
import { detectAndRecordHeaders, commitCsvImport, CsvImportNotFoundError, CsvImportWrongStatusError } from '../../integrations/csv-import';

const requestUploadInput = z.object({ storeId: z.string().uuid() });
const confirmUploadInput = z.object({ storeId: z.string().uuid(), key: z.string() });
const getImportInput = z.object({ importId: z.string().uuid() });
const columnMappingInput = z.object({
  occurredAt: z.string().min(1),
  posItemName: z.string().min(1),
  quantity: z.string().min(1),
  unitPrice: z.string().min(1),
  discount: z.string().min(1).optional(),
  lineTotal: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
});
const submitMappingInput = z.object({
  importId: z.string().uuid(),
  columnMapping: columnMappingInput,
  saveAsLabel: z.string().min(1).optional(),
});
const commitInput = z.object({ importId: z.string().uuid() });
const saveMappingInput = z.object({ label: z.string().min(1), columnMapping: columnMappingInput });

/** Idempotent, but only worth doing once per process — same reasoning/shape as `products.ts`'s own `ensureBucketOnce`, a separate bucket needing its own one-time creation. */
let bucketEnsured = false;
const ensureBucketOnce = async () => {
  if (bucketEnsured) return;
  await ensureBucketExists(storageClient, SALES_CSV_IMPORTS_BUCKET);
  bucketEnsured = true;
};

/**
 * 006-10 (plan.md Phase 5): upload -> detect headers -> human maps columns -> commit (parse +
 * write + trigger consumption). Same two-step upload shape as `products.requestImageUpload`/
 * `confirmImageUpload` (spec 14 §14.3/§14.7: presigned URL, never proxied through the API; bytes
 * verified server-side after upload, never trusted from the client's declared content-type) —
 * `requestUpload` never touches `sales_csv_imports` and never mints a real import id; the row is
 * created ONLY at `confirmUpload`, once the actual uploaded bytes have been downloaded and
 * verified, matching `products.confirmImageUpload`'s exact reasoning ("a presigned URL being
 * issued proves nothing about what bytes actually get uploaded, or whether upload happens at
 * all").
 */
export const csvImportRouter = router({
  requestUpload: protectedProcedure.input(requestUploadInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }
    await ensureBucketOnce();

    const key = buildCsvImportKey(ctx.session.organizationId, randomUUID());
    const uploadUrl = await createPresignedUploadUrl(storageClient, SALES_CSV_IMPORTS_BUCKET, key, 'text/csv');

    return { uploadUrl, key };
  }),

  /** Downloads and verifies the just-uploaded bytes, creates the real `sales_csv_imports` row, and detects headers/delimiter for the mapping UI's preview — all in this one step, since header detection needs the verified bytes anyway. */
  confirmUpload: protectedProcedure.input(confirmUploadInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    if (!input.key.startsWith(`org/${ctx.session.organizationId}/`)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Upload key does not belong to this organization.' });
    }

    const bytes = await getObjectBytes(storageClient, SALES_CSV_IMPORTS_BUCKET, input.key);
    const validation = validateCsvUpload(bytes);
    if (!validation.valid) {
      const messages: Record<typeof validation.reason, string> = {
        TOO_LARGE: 'Uploaded file exceeds the maximum allowed size.',
        NOT_UTF8_TEXT: 'Uploaded file is not valid UTF-8 text.',
        LOOKS_LIKE_BINARY_FORMAT: 'Uploaded file looks like an Excel (.xlsx) or other binary file — only plain CSV is supported.',
      };
      throw new TRPCError({ code: 'BAD_REQUEST', message: messages[validation.reason] });
    }

    const csvImportRepository = new CsvImportRepository(ctx.db, ctx.session.organizationId);
    const importRow = await csvImportRepository.create({
      storeId: input.storeId,
      storageKey: input.key,
      uploadedByUserId: ctx.session.userId,
    });

    try {
      const detected = await detectAndRecordHeaders(ctx.db, ctx.session.organizationId, importRow.id, validation.text);
      return { importId: importRow.id, ...detected };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not detect CSV headers.';
      await csvImportRepository.recordFailure(importRow.id, message);
      throw new TRPCError({ code: 'BAD_REQUEST', message });
    }
  }),

  get: protectedProcedure.input(getImportInput).query(async ({ ctx, input }) => {
    const csvImportRepository = new CsvImportRepository(ctx.db, ctx.session.organizationId);
    const importRow = await csvImportRepository.findById(input.importId);
    if (!importRow) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'CSV import not found.' });
    }
    return importRow;
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const csvImportRepository = new CsvImportRepository(ctx.db, ctx.session.organizationId);
    return csvImportRepository.findAllForOrganization();
  }),

  /** The human's confirmed column mapping (I9) — records it and, if `saveAsLabel` is given, also saves it as a reusable per-tenant mapping (plan.md: "save the column mapping per tenant so repeat imports are one click"). */
  submitColumnMapping: protectedProcedure.input(submitMappingInput).mutation(async ({ ctx, input }) => {
    const csvImportRepository = new CsvImportRepository(ctx.db, ctx.session.organizationId);
    const importRow = await csvImportRepository.findById(input.importId);
    if (!importRow) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'CSV import not found.' });
    }

    const updated = await csvImportRepository.recordColumnMapping(input.importId, input.columnMapping);

    if (input.saveAsLabel) {
      const savedMappingRepository = new SavedCsvMappingRepository(ctx.db, ctx.session.organizationId);
      await savedMappingRepository.upsert(input.saveAsLabel, input.columnMapping);
    }

    return updated;
  }),

  /** Parses every row per the confirmed mapping, writes them idempotently, and triggers consumption. The whole point of `MAPPED` as a distinct status: a human must confirm the mapping before any row is ever written (I9). */
  commit: protectedProcedure.input(commitInput).mutation(async ({ ctx, input }) => {
    const csvImportRepository = new CsvImportRepository(ctx.db, ctx.session.organizationId);
    const importRow = await csvImportRepository.findById(input.importId);
    if (!importRow) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'CSV import not found.' });
    }

    const bytes = await getObjectBytes(storageClient, SALES_CSV_IMPORTS_BUCKET, importRow.storageKey);
    const validation = validateCsvUpload(bytes);
    if (!validation.valid) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Uploaded file is no longer valid.' });
    }

    try {
      return await commitCsvImport(ctx.db, ctx.session.organizationId, input.importId, validation.text);
    } catch (err) {
      if (err instanceof CsvImportNotFoundError) {
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
      }
      if (err instanceof CsvImportWrongStatusError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'CSV import failed. Check the column mapping and try again.' });
    }
  }),

  savedMappings: protectedProcedure.query(async ({ ctx }) => {
    const savedMappingRepository = new SavedCsvMappingRepository(ctx.db, ctx.session.organizationId);
    return savedMappingRepository.findAllForOrganization();
  }),

  saveMapping: protectedProcedure.input(saveMappingInput).mutation(async ({ ctx, input }) => {
    const savedMappingRepository = new SavedCsvMappingRepository(ctx.db, ctx.session.organizationId);
    return savedMappingRepository.upsert(input.label, input.columnMapping);
  }),
});
