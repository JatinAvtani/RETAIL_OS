import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { CatalogCsvImportRepository, SavedCatalogCsvMappingRepository } from '@retailos/db';
import { buildCatalogCsvImportKey, createPresignedUploadUrl, ensureBucketExists, getObjectBytes, validateCsvUpload } from '@retailos/storage';
import { protectedProcedure, router } from '../trpc';
import { storageClient, CATALOG_CSV_IMPORTS_BUCKET } from '../context';
import {
  detectAndRecordCatalogCsvHeaders,
  commitProductCatalogCsvImport,
  commitSupplierCatalogCsvImport,
  commitRecipeCatalogCsvImport,
  CatalogCsvImportNotFoundError,
  CatalogCsvImportWrongStatusError,
} from '../../integrations/catalog-csv-import';

const importTypeInput = z.enum(['PRODUCT', 'SUPPLIER', 'RECIPE']);

const requestUploadInput = z.object({ importType: importTypeInput });
const confirmUploadInput = z.object({ importType: importTypeInput, key: z.string() });
const getImportInput = z.object({ importId: z.string().uuid() });
const listInput = z.object({ importType: importTypeInput.optional() }).optional();

const productColumnMappingInput = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().min(1),
  type: z.string().min(1),
  category: z.string().min(1).optional(),
});
const supplierColumnMappingInput = z.object({
  name: z.string().min(1),
  paymentTerms: z.string().min(1).optional(),
  leadTimeDaysContracted: z.string().min(1).optional(),
  minOrderValue: z.string().min(1).optional(),
});
const recipeColumnMappingInput = z.object({
  recipeName: z.string().min(1),
  yieldQuantity: z.string().min(1),
  yieldUnit: z.string().min(1),
  componentProductName: z.string().min(1),
  componentQuantity: z.string().min(1),
  componentUnit: z.string().min(1),
  wasteFactor: z.string().min(1).optional(),
});
/** A discriminated shape isn't practical here (each mapping is a plain field->header record with no shared tag) — the router validates the outer `importType` matches the ALREADY-recorded import's own `importType` before trusting whichever mapping shape came in, so a request naming the wrong pair still can't corrupt another import's mapping. */
const columnMappingInput = z.union([productColumnMappingInput, supplierColumnMappingInput, recipeColumnMappingInput]);

const submitMappingInput = z.object({
  importId: z.string().uuid(),
  columnMapping: columnMappingInput,
  saveAsLabel: z.string().min(1).optional(),
});
const commitInput = z.object({ importId: z.string().uuid() });
const savedMappingsInput = z.object({ importType: importTypeInput });
const saveMappingInput = z.object({ importType: importTypeInput, label: z.string().min(1), columnMapping: columnMappingInput });

let bucketEnsured = false;
const ensureBucketOnce = async () => {
  if (bucketEnsured) return;
  await ensureBucketExists(storageClient, CATALOG_CSV_IMPORTS_BUCKET);
  bucketEnsured = true;
};

/**
 * CSV import for products, suppliers, and recipes — the exact same
 * upload -> detect headers -> human maps columns -> commit shape `csvImportRouter` (sales) already
 * established, parameterized by `importType` instead of duplicated wholesale. Org-scoped only, not
 * store-scoped: products/suppliers/recipes are org-level master data (unlike sales transactions),
 * so this router has no `storeId` input or `canAccessStore` check anywhere — every procedure's
 * tenant boundary is `ctx.session.organizationId` alone, matching
 * `products.create`/`suppliers.create`/`recipes.create`.
 */
export const catalogCsvImportRouter = router({
  requestUpload: protectedProcedure.input(requestUploadInput).mutation(async ({ ctx }) => {
    await ensureBucketOnce();
    const key = buildCatalogCsvImportKey(ctx.session.organizationId, randomUUID());
    const uploadUrl = await createPresignedUploadUrl(storageClient, CATALOG_CSV_IMPORTS_BUCKET, key, 'text/csv');
    return { uploadUrl, key };
  }),

  confirmUpload: protectedProcedure.input(confirmUploadInput).mutation(async ({ ctx, input }) => {
    if (!input.key.startsWith(`org/${ctx.session.organizationId}/`)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Upload key does not belong to this organization.' });
    }

    const bytes = await getObjectBytes(storageClient, CATALOG_CSV_IMPORTS_BUCKET, input.key);
    const validation = validateCsvUpload(bytes);
    if (!validation.valid) {
      const messages: Record<typeof validation.reason, string> = {
        TOO_LARGE: 'Uploaded file exceeds the maximum allowed size.',
        NOT_UTF8_TEXT: 'Uploaded file is not valid UTF-8 text.',
        LOOKS_LIKE_BINARY_FORMAT: 'Uploaded file looks like an Excel (.xlsx) or other binary file — only plain CSV is supported.',
      };
      throw new TRPCError({ code: 'BAD_REQUEST', message: messages[validation.reason] });
    }

    const repository = new CatalogCsvImportRepository(ctx.db, ctx.session.organizationId);
    const importRow = await repository.create({
      importType: input.importType,
      storageKey: input.key,
      uploadedByUserId: ctx.session.userId,
    });

    try {
      const detected = await detectAndRecordCatalogCsvHeaders(ctx.db, ctx.session.organizationId, importRow.id, validation.text);
      return { importId: importRow.id, ...detected };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not detect CSV headers.';
      await repository.recordFailure(importRow.id, message);
      throw new TRPCError({ code: 'BAD_REQUEST', message });
    }
  }),

  get: protectedProcedure.input(getImportInput).query(async ({ ctx, input }) => {
    const repository = new CatalogCsvImportRepository(ctx.db, ctx.session.organizationId);
    const importRow = await repository.findById(input.importId);
    if (!importRow) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalog CSV import not found.' });
    }
    return importRow;
  }),

  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const repository = new CatalogCsvImportRepository(ctx.db, ctx.session.organizationId);
    return repository.findAllForOrganization(input?.importType);
  }),

  submitColumnMapping: protectedProcedure.input(submitMappingInput).mutation(async ({ ctx, input }) => {
    const repository = new CatalogCsvImportRepository(ctx.db, ctx.session.organizationId);
    const importRow = await repository.findById(input.importId);
    if (!importRow) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalog CSV import not found.' });
    }

    const updated = await repository.recordColumnMapping(input.importId, input.columnMapping);

    if (input.saveAsLabel) {
      const savedMappingRepository = new SavedCatalogCsvMappingRepository(ctx.db, ctx.session.organizationId);
      await savedMappingRepository.upsert(importRow.importType, input.saveAsLabel, input.columnMapping);
    }

    return updated;
  }),

  commit: protectedProcedure.input(commitInput).mutation(async ({ ctx, input }) => {
    const repository = new CatalogCsvImportRepository(ctx.db, ctx.session.organizationId);
    const importRow = await repository.findById(input.importId);
    if (!importRow) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalog CSV import not found.' });
    }

    const bytes = await getObjectBytes(storageClient, CATALOG_CSV_IMPORTS_BUCKET, importRow.storageKey);
    const validation = validateCsvUpload(bytes);
    if (!validation.valid) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Uploaded file is no longer valid.' });
    }

    try {
      if (importRow.importType === 'PRODUCT') {
        return await commitProductCatalogCsvImport(ctx.db, ctx.session.organizationId, input.importId, validation.text);
      }
      if (importRow.importType === 'SUPPLIER') {
        return await commitSupplierCatalogCsvImport(ctx.db, ctx.session.organizationId, input.importId, validation.text);
      }
      return await commitRecipeCatalogCsvImport(ctx.db, ctx.session.organizationId, input.importId, validation.text);
    } catch (err) {
      if (err instanceof CatalogCsvImportNotFoundError) {
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
      }
      if (err instanceof CatalogCsvImportWrongStatusError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      /**
       * The user-facing message stays generic — an internal exception is not something to render
       * into a UI. But the original error is attached as `cause` and logged, because discarding it
       * entirely made a real failure undiagnosable: this path fired in CI and the only signal
       * anywhere was "Check the column mapping", with nothing naming what actually broke.
       */
      ctx.req.log.error({ err, importId: input.importId }, 'catalog CSV import commit failed');
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Catalog CSV import failed. Check the column mapping and try again.',
        cause: err,
      });
    }
  }),

  savedMappings: protectedProcedure.input(savedMappingsInput).query(async ({ ctx, input }) => {
    const savedMappingRepository = new SavedCatalogCsvMappingRepository(ctx.db, ctx.session.organizationId);
    return savedMappingRepository.findAllForOrganization(input.importType);
  }),

  saveMapping: protectedProcedure.input(saveMappingInput).mutation(async ({ ctx, input }) => {
    const savedMappingRepository = new SavedCatalogCsvMappingRepository(ctx.db, ctx.session.organizationId);
    return savedMappingRepository.upsert(input.importType, input.label, input.columnMapping);
  }),
});
