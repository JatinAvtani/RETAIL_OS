import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { canAccessStore } from '@retailos/authz';
import { GoodsReceiptRepository, PurchaseOrderRepository, StoreRepository, SupplierRepository, UnknownReceiptCostError, MissingReceiveLineProductError } from '@retailos/db';
import {
  buildGoodsReceiptLinePhotoKey,
  createPresignedUploadUrl,
  ensureBucketExists,
  getObjectBytes,
  validateGoodsReceiptPhoto,
} from '@retailos/storage';
import { protectedProcedure, router } from '../trpc';
import { storageClient, GOODS_RECEIPT_PHOTOS_BUCKET } from '../context';
import type { db as Db } from '../context';

const discrepancyCodes = ['SHORT', 'OVER', 'DAMAGED', 'WRONG_ITEM', 'LATE'] as const;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Idempotent, matching `documents.ts`/`purchase-orders.ts`'s own `ensureBucketOnce` precedent. */
let photosBucketEnsured = false;
const ensurePhotosBucketOnce = async () => {
  if (photosBucketEnsured) return;
  await ensureBucketExists(storageClient, GOODS_RECEIPT_PHOTOS_BUCKET);
  photosBucketEnsured = true;
};

const receiveLineInput = z.object({
  purchaseOrderLineId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  receivedQuantityBaseUnits: z.string(),
  baseUnitId: z.string().uuid().optional(),
  unitCost: z.string().optional(),
  currency: z.string().length(3).optional(),
  lotNumber: z.string().trim().max(100).optional(),
  expiryDate: z.string().optional(),
  discrepancyCode: z.enum(discrepancyCodes).optional(),
  discrepancyNotes: z.string().trim().max(1000).optional(),
  lineNumber: z.number().int().min(1),
});

const confirmReceiptInput = z.object({
  storeId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().optional(),
  supplierId: z.string().uuid(),
  receivedAt: z.string().datetime(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(receiveLineInput).min(1),
});

const getInput = z.object({ goodsReceiptId: z.string().uuid() });

const requestPhotoUploadInput = z.object({
  goodsReceiptLineId: z.string().uuid(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

const confirmPhotoUploadInput = z.object({
  goodsReceiptLineId: z.string().uuid(),
  key: z.string(),
});

/** Same `assertStoreAccess` two-layer pattern `purchase-orders.ts`/`inventory.ts`/`stocktake.ts` established. */
const assertStoreAccess = async (
  db: typeof Db,
  session: { organizationId: string; storeIds: string[] | 'ALL' },
  storeId: string
) => {
  const storeRepository = new StoreRepository(db, session.organizationId);
  const store = await storeRepository.findById(storeId);
  if (!store || !canAccessStore(session, storeId)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
  }
};

const assertSupplierExists = async (db: typeof Db, organizationId: string, supplierId: string) => {
  const supplierRepository = new SupplierRepository(db, organizationId);
  const supplier = await supplierRepository.findById(supplierId);
  if (!supplier) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Supplier not found.' });
  }
};

const requirePermission = (permissions: string[], permission: string) => {
  if (!permissions.includes(permission)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  }
};

/**
 * 008-07 (plan.md Phase 3, spec 05 §5.2.3): the real HTTP surface for `GoodsReceiptRepository`.
 * No dedicated `purchasing:receive` permission exists in `packages/authz` (only read/write/approve)
 * — reuses `purchasing:write`, the same permission `purchaseOrders.addLine`/`.create` already gate,
 * since adding a new permission enum value for one action is a bigger, harder-to-reverse change than
 * this task needs. `confirmReceipt`'s `purchaseOrderId` is optional (008-09's future walk-in-receipt
 * scope), but this router still requires `storeId`/`supplierId` to both belong to the caller's org,
 * matching every other endpoint's cross-tenant discipline regardless of whether a PO is involved.
 */
export const goodsReceiptsRouter = router({
  confirmReceipt: protectedProcedure.input(confirmReceiptInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    await assertStoreAccess(ctx.db, ctx.session, input.storeId);
    await assertSupplierExists(ctx.db, ctx.session.organizationId, input.supplierId);

    if (input.purchaseOrderId !== undefined) {
      const poRepo = new PurchaseOrderRepository(ctx.db, ctx.session.organizationId);
      const po = await poRepo.findById(input.purchaseOrderId);
      if (!po) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase order not found.' });
      }
    }

    const repo = new GoodsReceiptRepository(ctx.db, ctx.session.organizationId);
    try {
      const result = await repo.confirmReceipt({
        storeId: input.storeId,
        ...(input.purchaseOrderId !== undefined ? { purchaseOrderId: input.purchaseOrderId } : {}),
        supplierId: input.supplierId,
        receivedAt: new Date(input.receivedAt),
        receivedByUserId: ctx.session.userId,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        // `exactOptionalPropertyTypes` rejects zod's `string | undefined` optional fields being
        // spread directly into `ReceiveLineInput`'s `?:` shape (which means "absent", not "present
        // as undefined") — mapped explicitly per line, same discipline `purchase-orders.ts`'s
        // `addLine` handler already established for this exact TS strictness setting.
        lines: input.lines.map((line) => ({
          receivedQuantityBaseUnits: line.receivedQuantityBaseUnits,
          lineNumber: line.lineNumber,
          ...(line.purchaseOrderLineId !== undefined ? { purchaseOrderLineId: line.purchaseOrderLineId } : {}),
          ...(line.productId !== undefined ? { productId: line.productId } : {}),
          ...(line.variantId !== undefined ? { variantId: line.variantId } : {}),
          ...(line.baseUnitId !== undefined ? { baseUnitId: line.baseUnitId } : {}),
          ...(line.unitCost !== undefined ? { unitCost: line.unitCost } : {}),
          ...(line.currency !== undefined ? { currency: line.currency } : {}),
          ...(line.lotNumber !== undefined ? { lotNumber: line.lotNumber } : {}),
          ...(line.expiryDate !== undefined ? { expiryDate: line.expiryDate } : {}),
          ...(line.discrepancyCode !== undefined ? { discrepancyCode: line.discrepancyCode } : {}),
          ...(line.discrepancyNotes !== undefined ? { discrepancyNotes: line.discrepancyNotes } : {}),
        })),
      });
      return result;
    } catch (err) {
      if (err instanceof UnknownReceiptCostError || err instanceof MissingReceiveLineProductError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
      // Every other real failure here (the received-within-ordered CHECK constraint, an illegal
      // PO-state transition from the domain state machine) is a genuine validation error, not a
      // server fault — surfaced as 400 rather than a raw 500, matching this router's own I7
      // discipline of never masking a real, actionable rejection as an opaque server error.
      const message = err instanceof Error ? err.message : 'Could not confirm this receipt.';
      throw new TRPCError({ code: 'BAD_REQUEST', message });
    }
  }),

  get: protectedProcedure.input(getInput).query(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:read');
    const repo = new GoodsReceiptRepository(ctx.db, ctx.session.organizationId);
    const goodsReceipt = await repo.findById(input.goodsReceiptId);
    if (!goodsReceipt) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Goods receipt not found.' });
    }
    const lines = await repo.findLines(input.goodsReceiptId);
    return { goodsReceipt, lines };
  }),

  /**
   * 008-08 ("photos for damage claims"): two-step flow, not one — mirrors
   * `products.requestImageUpload`/`.confirmImageUpload` exactly. `requestPhotoUpload` only ever
   * hands out a URL that accepts a PUT of the declared content-type; it never touches
   * `goods_receipt_lines`, since a presigned URL being issued proves nothing about what bytes
   * actually get uploaded. `confirmPhotoUpload` is the only procedure that writes to
   * `photoObjectKeys`, and only after downloading the just-uploaded object and verifying its real
   * bytes server-side. Confirmed with the user: repeated single-photo calls for multiple photos on
   * one line, not a batch endpoint — matches the existing single-asset precedent exactly.
   */
  requestPhotoUpload: protectedProcedure.input(requestPhotoUploadInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    const repo = new GoodsReceiptRepository(ctx.db, ctx.session.organizationId);
    const line = await repo.findLineById(input.goodsReceiptLineId);
    if (!line) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Goods receipt line not found.' });
    }

    await ensurePhotosBucketOnce();

    const extension = EXTENSION_BY_CONTENT_TYPE[input.contentType]!;
    // A fresh photoId per upload, never a reused key — this line may already carry other real
    // photos in photoObjectKeys, and overwriting an in-flight (unconfirmed) upload's key would let
    // it race a legitimate later one, the same reasoning products.requestImageUpload documents.
    const key = buildGoodsReceiptLinePhotoKey(ctx.session.organizationId, input.goodsReceiptLineId, randomUUID(), extension);
    const uploadUrl = await createPresignedUploadUrl(storageClient, GOODS_RECEIPT_PHOTOS_BUCKET, key, input.contentType);

    return { uploadUrl, key };
  }),

  confirmPhotoUpload: protectedProcedure.input(confirmPhotoUploadInput).mutation(async ({ ctx, input }) => {
    requirePermission(ctx.session.permissions, 'purchasing:write');
    const repo = new GoodsReceiptRepository(ctx.db, ctx.session.organizationId);
    const line = await repo.findLineById(input.goodsReceiptLineId);
    if (!line) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Goods receipt line not found.' });
    }

    // The key itself is tenant-prefixed (buildGoodsReceiptLinePhotoKey) — refusing any key not
    // prefixed with this caller's own organizationId stops a caller from confirming an upload into
    // another tenant's namespace, matching products.confirmImageUpload's exact defense.
    if (!input.key.startsWith(`org/${ctx.session.organizationId}/`)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Upload key does not belong to this organization.' });
    }

    const bytes = await getObjectBytes(storageClient, GOODS_RECEIPT_PHOTOS_BUCKET, input.key);
    const validation = validateGoodsReceiptPhoto(bytes);
    if (!validation.valid) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          validation.reason === 'TOO_LARGE'
            ? 'Uploaded file exceeds the maximum allowed size.'
            : 'Uploaded file is not a valid JPEG, PNG, or WebP image.',
      });
    }

    await repo.appendPhotoKey(input.goodsReceiptLineId, input.key);
    return { key: input.key };
  }),
});
