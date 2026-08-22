import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { generateId } from '@retailos/domain';
import {
  DocumentRepository,
  ProductRepository,
  StoreRepository,
  SupplierProductRepository,
  SupplierRepository,
  UnitRepository,
} from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import { detectProductCandidates, detectSupplierCandidates, type UnmappedInvoiceLine, type UnmappedSupplierMention } from '@retailos/domain';
import { protectedProcedure, router } from '../trpc';

const detectInput = z.object({ storeId: z.string().uuid() });
const detectSuppliersInput = z.object({ storeId: z.string().uuid() });

const confirmSupplierInput = z.object({
  storeId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
});

const confirmProductInput = z.object({
  storeId: z.string().uuid(),
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  baseUnitCode: z.enum(['kg', 'g', 'l', 'ml', 'mg', 'each']),
  evidenceLines: z
    .array(
      z.object({
        documentId: z.string().uuid(),
        lineIndex: z.number().int().min(0),
      })
    )
    .min(1),
  packSize: z.string().trim().optional(),
});

type ExtractedLine = {
  sku?: { value: string | null };
  description?: { value: string | null };
  quantity?: { value: string | null };
  unit?: { value: string | null };
  unitPrice?: { value: string | null };
};

/**
 * 012-03 (spec 03 M9): "group extracted invoice lines by supplier SKU / description similarity,
 * propose one product per cluster, human confirms in bulk." This router only ever DETECTS and
 * SUGGESTS — it writes nothing (I9). Confirming a proposal into a real product +
 * `supplier_products` mapping is 012-05's separate, human-gated scope; this endpoint's whole
 * output is disposable, recomputed fresh on every call from the real current state of
 * `document_extractions`/`supplier_products`, never cached or persisted.
 */
export const productDetectionRouter = router({
  detectProducts: protectedProcedure.input(detectInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const supplierProductRepository = new SupplierProductRepository(ctx.db, ctx.session.organizationId);

    const extractions = await documentRepository.findApprovedExtractionsForStore(input.storeId);

    // Every confirmed mapping this org already has, keyed by (supplierId, supplierSku) — one
    // query, not N (one per line), since a real invoice history can have hundreds of lines.
    const confirmedMappings = await supplierProductRepository.findAll();
    const confirmedKeys = new Set(
      confirmedMappings.filter((m) => m.isConfirmed).map((m) => `${m.supplierId}:${m.supplierSku}`)
    );

    const supplierIdByName = new Map<string, string | null>();
    const resolveSupplierId = async (supplierName: string | null): Promise<string | null> => {
      if (!supplierName) return null;
      if (supplierIdByName.has(supplierName)) return supplierIdByName.get(supplierName)!;
      const supplier = await supplierRepository.findByExactName(supplierName);
      supplierIdByName.set(supplierName, supplier?.id ?? null);
      return supplier?.id ?? null;
    };

    const unmappedLines: UnmappedInvoiceLine[] = [];

    for (const extraction of extractions) {
      const fields = extraction.fields as { supplier?: { value: string | null } } | null;
      const supplierName = fields?.supplier?.value ?? null;
      const supplierId = await resolveSupplierId(supplierName);

      const lines = (extraction.lines as ExtractedLine[] | null) ?? [];
      lines.forEach((line, lineIndex) => {
        const description = line.description?.value?.trim();
        if (!description) return; // no real description text — nothing to cluster on (I7).

        const sku = line.sku?.value?.trim() || null;
        if (sku && supplierId && confirmedKeys.has(`${supplierId}:${sku}`)) {
          return; // already a real, confirmed product mapping — not a detection candidate.
        }

        unmappedLines.push({
          documentId: extraction.documentId,
          lineIndex,
          supplierSku: sku,
          description,
          quantity: line.quantity?.value ?? null,
          unit: line.unit?.value ?? null,
          unitPrice: line.unitPrice?.value ?? null,
        });
      });
    }

    return detectProductCandidates(unmappedLines);
  }),

  /**
   * 012-04: "cluster by name similarity, propose one supplier per cluster." Real, confirmed scope
   * narrowing (asked before writing this): plan.md also names tax ID/address clustering and
   * observed lead times, but `suppliers` has no taxId/address column and invoice extraction only
   * captures one `documentDate` (no order-date/delivery-date pair) — neither is buildable from real
   * data today, so neither is attempted (I7). Same detect-and-suggest-only contract as
   * `detectProducts` (I9) — writes nothing, recomputed fresh on every call.
   */
  detectSuppliers: protectedProcedure.input(detectSuppliersInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);

    const extractions = await documentRepository.findApprovedExtractionsForStore(input.storeId);

    // Two SEPARATE caches, not one — a name already confirmed to EXIST must keep being excluded on
    // every later occurrence, not just the first (a single merged "seen" set would let a second
    // mention of an already-real supplier wrongly fall through as undetected once its name was
    // marked "seen" by the exists-check alone).
    const existingSupplierNames = new Set<string>();
    const newSupplierNames = new Set<string>();
    const mentions: UnmappedSupplierMention[] = [];

    for (const extraction of extractions) {
      const fields = extraction.fields as { supplier?: { value: string | null } } | null;
      const supplierName = fields?.supplier?.value?.trim();
      if (!supplierName) continue; // no real supplier name extracted — nothing to cluster on (I7).

      if (existingSupplierNames.has(supplierName)) continue; // already confirmed to exist — skip.

      if (!newSupplierNames.has(supplierName)) {
        const existing = await supplierRepository.findByExactName(supplierName);
        if (existing) {
          existingSupplierNames.add(supplierName);
          continue;
        }
        newSupplierNames.add(supplierName);
      }

      mentions.push({ documentId: extraction.documentId, supplierName });
    }

    return detectSupplierCandidates(mentions);
  }),

  /**
   * 012-05: the real write path a detected supplier CANDIDATE alone cannot reach — detection never
   * writes (I9). The human confirms the FINAL name (editable in the bulk-confirm UI, not
   * necessarily the raw proposal) and this creates one real `suppliers` row. `storeId` is here only
   * to prove tenancy the same two-layer way every other store-scoped write in this codebase does;
   * `suppliers` itself is org-scoped, not store-scoped, matching `suppliers.create`'s own shape.
   */
  confirmSupplier: protectedProcedure.input(confirmSupplierInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    return supplierRepository.create({ id: generateId(), name: input.name });
  }),

  /**
   * 012-05: the real write path a detected product CANDIDATE alone cannot reach. Creates one real
   * product (+ its default variant, via `ProductRepository.create`'s own invariant), then a real
   * CONFIRMED `supplier_products` mapping for every evidence line's real `(supplier, sku)` pair —
   * this is the "permanent deterministic mapping" plan.md's own acceptance criterion names: once
   * confirmed, a LATER invoice with the same supplier SKU needs no further review. A line whose
   * document names a supplier with no real `suppliers` row yet (the human hasn't confirmed that
   * supplier candidate first) is reported back as `skippedLines`, never silently dropped or mapped
   * to a guessed supplier (I7) — the caller decides whether to confirm suppliers first and retry.
   * A line with no real extracted SKU has nothing to map (I7) and is skipped the same honest way.
   */
  confirmProduct: protectedProcedure.input(confirmProductInput).mutation(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const unitRepository = new UnitRepository(ctx.db);
    const baseUnit = await unitRepository.findByCode(input.baseUnitCode);
    if (!baseUnit) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Real unit '${input.baseUnitCode}' not found — has this environment's global unit vocabulary been seeded?` });
    }

    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const supplierProductRepository = new SupplierProductRepository(ctx.db, ctx.session.organizationId);
    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);

    const product = await productRepository.create({
      id: generateId(),
      sku: input.sku,
      name: input.name,
      baseUnitId: baseUnit.id,
      type: 'INGREDIENT',
    });

    const packUnit = input.packSize ? baseUnit : null;

    // Every evidence line's own real (supplier, sku) pair, deduplicated — a cluster's evidence can
    // legitimately span multiple documents from the SAME supplier repeating the same SKU.
    const mappedKeys = new Set<string>();
    const confirmedMappings: Array<{ id: string }> = [];
    const skippedLines: Array<{ documentId: string; lineIndex: number; reason: string }> = [];

    for (const evidenceLine of input.evidenceLines) {
      const extraction = await documentRepository.getLatestExtraction(evidenceLine.documentId);
      const fields = extraction?.fields as { supplier?: { value: string | null } } | undefined;
      const lines = extraction?.lines as Array<{ sku?: { value: string | null } }> | undefined;
      const supplierName = fields?.supplier?.value?.trim();
      const sku = lines?.[evidenceLine.lineIndex]?.sku?.value?.trim();

      if (!supplierName) {
        skippedLines.push({ ...evidenceLine, reason: 'No supplier extracted for this document.' });
        continue;
      }
      if (!sku) {
        skippedLines.push({ ...evidenceLine, reason: 'No SKU extracted for this line.' });
        continue;
      }

      const supplier = await supplierRepository.findByExactName(supplierName);
      if (!supplier) {
        skippedLines.push({ ...evidenceLine, reason: `Supplier "${supplierName}" is not confirmed yet — confirm it first.` });
        continue;
      }

      const key = `${supplier.id}:${sku}`;
      if (mappedKeys.has(key)) continue;
      mappedKeys.add(key);

      const existing = await supplierProductRepository.findBySupplierAndSku(supplier.id, sku);
      const mapping = existing
        ? existing.isConfirmed
          ? existing
          : await supplierProductRepository.confirm(existing.id)
        : await (async () => {
            const created = await supplierProductRepository.create({
              id: generateId(),
              supplierId: supplier.id,
              productId: product.id,
              supplierSku: sku,
              ...(input.packSize !== undefined ? { packSize: input.packSize } : {}),
              ...(packUnit ? { packUnitId: packUnit.id } : {}),
            });
            return supplierProductRepository.confirm(created.id);
          })();

      if (mapping) confirmedMappings.push({ id: mapping.id });
    }

    return { product, confirmedMappingCount: confirmedMappings.length, skippedLines };
  }),
});
