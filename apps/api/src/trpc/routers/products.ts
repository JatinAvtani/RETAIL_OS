import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { CategoryRepository, ProductRepository, UnitRepository } from '@retailos/db';
import { generateId } from '@retailos/domain';
import {
  buildProductImageKey,
  createPresignedUploadUrl,
  ensureBucketExists,
  getObjectBytes,
  validateProductImage,
} from '@retailos/storage';
import { protectedProcedure, router } from '../trpc';
import { PRODUCT_IMAGES_BUCKET, storageClient } from '../context';

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const requestImageUploadInput = z.object({
  productId: z.string().uuid(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

const confirmImageUploadInput = z.object({
  productId: z.string().uuid(),
  key: z.string(),
});

const getInput = z.object({ id: z.string().uuid() });

const createInput = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  baseUnitId: z.string().uuid(),
  type: z.enum(['INGREDIENT', 'SELLABLE', 'BOTH']),
  categoryId: z.string().uuid().optional(),
  isPerishable: z.boolean().optional(),
});

const updateInput = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  isPerishable: z.boolean().optional(),
  defaultShelfLifeDays: z.number().int().positive().nullable().optional(),
});

/**
 * Idempotent, but only worth doing once per process, not once per request — `HeadBucketCommand`
 * is a real network round trip against MinIO/S3 on every call. `ensureBucketExists` itself is
 * still idempotent if this ever runs twice (process restart, race on first request).
 */
let bucketEnsured = false;
const ensureBucketOnce = async () => {
  if (bucketEnsured) return;
  await ensureBucketExists(storageClient, PRODUCT_IMAGES_BUCKET);
  bucketEnsured = true;
};

/**
 * the design/: uploads go via presigned URLs, never proxied through the API; paths are
 * tenant-prefixed; type is verified by magic bytes, not the client's claimed content-type or
 * filename extension. Two-step flow, not one: `requestImageUpload` only ever hands out a URL that
 * accepts a PUT of the declared content-type — it does not touch `products.imageUrl`, since a
 * presigned URL being issued proves nothing about what bytes actually get uploaded, or whether
 * upload happens at all. `confirmImageUpload` is the only procedure that writes to `products`, and
 * only after downloading the just-uploaded object and verifying its real bytes server-side.
 */
export const productsRouter = router({
  /**
   * Plain listing for now, not real trigram fuzzy search — the plan specifies pg_trgm-based search
   * for the catalog UI, but that's deferred until there's enough product volume in dev/testing to
   * meaningfully verify it finds near-matches, not just exact ones (asked the user, confirmed).
   * `nameContains` is a simple case-insensitive substring filter in the meantime.
   */
  list: protectedProcedure
    .input(z.object({ nameContains: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
      const all = await productRepository.findAll();
      if (!input?.nameContains) return all;
      const needle = input.nameContains.toLowerCase();
      return all.filter((product) => product.name.toLowerCase().includes(needle));
    }),

  get: protectedProcedure.input(getInput).query(async ({ ctx, input }) => {
    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const product = await productRepository.findById(input.id);
    if (!product) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
    }
    return product;
  }),

  /**
   * Every product has a default variant from creation (`ProductRepository.create`'s own
   * invariant) — no caller needed to resolve one to an id before the onboarding wizard's par-levels
   * step (012-01), the first UI needing a real `variantId` for a product picked by name alone.
   *
   * `findVariants` itself already returns `[]`, not a throw, for a cross-org productId — a real,
   * genuine 200 that the cross-tenant registry's own completeness check correctly caught (a `200`
   * with an empty result for a cross-org id lookup is still a convention violation this codebase
   * doesn't allow, matching `invoiceMatches.getByDocument`'s own documented precedent). Checking
   * ownership explicitly here, the same shape as `get` above, turns that into a real 404.
   */
  getVariants: protectedProcedure.input(getInput).query(async ({ ctx, input }) => {
    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const product = await productRepository.findById(input.id);
    if (!product) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
    }
    return productRepository.findVariants(input.id);
  }),

  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    // baseUnitId/categoryId are real FKs, but neither failure mode should surface as a raw
    // Postgres constraint error — verifying both up front, the same shape as
    // CategoryRepository.create checking a parent category before inserting a child, gives a real
    // "not found" instead.
    const unitRepository = new UnitRepository(ctx.db);
    const unit = await unitRepository.findAll().then((units) => units.find((u) => u.id === input.baseUnitId));
    if (!unit) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'baseUnitId does not refer to a real unit.' });
    }

    if (input.categoryId) {
      const categoryRepository = new CategoryRepository(ctx.db, ctx.session.organizationId);
      const category = await categoryRepository.findById(input.categoryId);
      if (!category) {
        // NOT_FOUND, not BAD_REQUEST, matching every other cross-tenant guard in this codebase
        // (stores.get, products.get,...): from this org's perspective the id simply doesn't
        // exist, whether it's a typo or genuinely belongs to another tenant — the response can't
        // and shouldn't distinguish those two cases.
        throw new TRPCError({ code: 'NOT_FOUND', message: 'categoryId does not refer to a category in this organization.' });
      }
    }

    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    try {
      return await productRepository.create({
        id: generateId(),
        sku: input.sku,
        name: input.name,
        baseUnitId: input.baseUnitId,
        type: input.type,
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.isPerishable !== undefined && { isPerishable: input.isPerishable }),
      });
    } catch (err) {
      // The partial unique index on (organization_id, sku) WHERE deleted_at IS NULL is the real
      // backstop; this just turns a raw constraint violation into a message a form can show.
      if (err instanceof Error && /unique/i.test(err.message)) {
        throw new TRPCError({ code: 'CONFLICT', message: `SKU '${input.sku}' is already in use.` });
      }
      throw err;
    }
  }),

  update: protectedProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    if (input.categoryId) {
      const categoryRepository = new CategoryRepository(ctx.db, ctx.session.organizationId);
      const category = await categoryRepository.findById(input.categoryId);
      if (!category) {
        // NOT_FOUND, not BAD_REQUEST, matching every other cross-tenant guard in this codebase
        // (stores.get, products.get,...): from this org's perspective the id simply doesn't
        // exist, whether it's a typo or genuinely belongs to another tenant — the response can't
        // and shouldn't distinguish those two cases.
        throw new TRPCError({ code: 'NOT_FOUND', message: 'categoryId does not refer to a category in this organization.' });
      }
    }

    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const updated = await productRepository.update(input.id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      ...(input.isPerishable !== undefined && { isPerishable: input.isPerishable }),
      ...(input.defaultShelfLifeDays !== undefined && { defaultShelfLifeDays: input.defaultShelfLifeDays }),
    });
    if (!updated) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
    }
    return updated;
  }),

  requestImageUpload: protectedProcedure.input(requestImageUploadInput).mutation(async ({ ctx, input }) => {
    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const product = await productRepository.findById(input.productId);
    if (!product) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
    }

    await ensureBucketOnce();

    const extension = EXTENSION_BY_CONTENT_TYPE[input.contentType];
    // Every upload gets a fresh key, not a reused image.<ext> — overwriting the same key would
    // let a caller with an in-flight (unconfirmed) presigned URL race a legitimate later upload.
    const key = buildProductImageKey(ctx.session.organizationId, `${product.id}-${randomUUID()}`, extension!);
    const uploadUrl = await createPresignedUploadUrl(storageClient, PRODUCT_IMAGES_BUCKET, key, input.contentType);

    return { uploadUrl, key };
  }),

  confirmImageUpload: protectedProcedure.input(confirmImageUploadInput).mutation(async ({ ctx, input }) => {
    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const product = await productRepository.findById(input.productId);
    if (!product) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Product not found.' });
    }

    // The key itself is tenant-prefixed (buildProductImageKey) — refusing any key not prefixed
    // with this caller's own organizationId stops a caller from confirming (and thus reading
    // cost-free) an upload into another tenant's namespace, even though the presigned URL that
    // produced it was already scoped to whoever requested it.
    if (!input.key.startsWith(`org/${ctx.session.organizationId}/`)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Upload key does not belong to this organization.' });
    }

    const bytes = await getObjectBytes(storageClient, PRODUCT_IMAGES_BUCKET, input.key);
    const validation = validateProductImage(bytes);
    if (!validation.valid) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          validation.reason === 'TOO_LARGE'
            ? 'Uploaded file exceeds the maximum allowed size.'
            : 'Uploaded file is not a valid JPEG, PNG, or WebP image.',
      });
    }

    return productRepository.setImageKey(input.productId, input.key);
  }),
});
