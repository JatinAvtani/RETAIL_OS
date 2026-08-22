import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  DocumentRepository,
  ProductRepository,
  StoreRepository,
  SupplierPerformanceEventRepository,
  SupplierPriceRepository,
  SupplierProductRepository,
  SupplierRepository,
  UnitRepository,
} from '@retailos/db';
import { canAccessStore } from '@retailos/authz';
import {
  buildCrossSupplierPriceFindings,
  buildDuplicateInvoiceFindings,
  buildPriceChangeFinding,
  rankFindings,
  type Finding,
} from '@retailos/domain';
import { protectedProcedure, router } from '../trpc';

const reportInput = z.object({
  storeId: z.string().uuid(),
  days: z.number().int().min(1).max(365).default(90),
});

/**
 * 012-10: "generated once enough invoices are processed... every claim cites its source
 * documents. This report is the product's proof." (plan.md). This router only ever GATHERS real,
 * already-persisted data and hands it to the pure builders in `@retailos/domain` (I1/I2) — no
 * business number is computed here, and nothing is written or cached; the report is recomputed
 * fresh on every call from the real current state of `supplier_performance_events`/`documents`/
 * `supplier_products`/`supplier_prices`.
 */
export const firstFindingReportRouter = router({
  generate: protectedProcedure.input(reportInput).query(async ({ ctx, input }) => {
    const storeRepository = new StoreRepository(ctx.db, ctx.session.organizationId);
    const store = await storeRepository.findById(input.storeId);
    if (!store || !canAccessStore(ctx.session, input.storeId)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Store not found.' });
    }

    const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);

    const supplierPerformanceEventRepository = new SupplierPerformanceEventRepository(ctx.db, ctx.session.organizationId);
    const documentRepository = new DocumentRepository(ctx.db, ctx.session.organizationId);
    const supplierRepository = new SupplierRepository(ctx.db, ctx.session.organizationId);
    const productRepository = new ProductRepository(ctx.db, ctx.session.organizationId);
    const supplierProductRepository = new SupplierProductRepository(ctx.db, ctx.session.organizationId);
    const supplierPriceRepository = new SupplierPriceRepository(ctx.db, ctx.session.organizationId);
    const unitRepository = new UnitRepository(ctx.db);

    const [suppliers, products, units, priceChangeEvents, invoiceHeaders] = await Promise.all([
      supplierRepository.findAll(),
      productRepository.findAll(),
      unitRepository.findAll(),
      supplierPerformanceEventRepository.findPriceChangesForOrgSince(since),
      documentRepository.findApprovedInvoiceHeadersForStoreSince(input.storeId, since),
    ]);
    const supplierNameById = new Map(suppliers.map((s) => [s.id, s.name]));
    const productNameById = new Map(products.map((p) => [p.id, p.name]));
    const unitCodeById = new Map(units.map((u) => [u.id, u.code]));

    const findings: Finding[] = [];

    // --- Price change findings — reads the already-computed variance off real PRICE_CHANGE events.
    for (const event of priceChangeEvents) {
      if (!event.productId || event.expectedValue === null || event.actualValue === null) continue; // no real comparable pair (I7).
      const supplierName = supplierNameById.get(event.supplierId);
      const productName = productNameById.get(event.productId);
      if (!supplierName || !productName) continue;

      const finding = buildPriceChangeFinding({
        supplierName,
        productName,
        expectedValue: event.expectedValue,
        actualValue: event.actualValue,
        variance: event.variance,
        occurredAt: event.occurredAt,
        evidenceDocumentIds: event.documentId ? [event.documentId] : [],
      });
      if (finding) findings.push(finding);
    }

    // Real headline denominator: every distinct real supplier name named on an approved invoice
    // this store received in the window — never a fabricated count, and never scoped to only the
    // subset of invoices that happened to produce a finding.
    const distinctSupplierNamesSeen = new Set<string>();

    // --- Duplicate invoice findings — real content-hash matches among this store's approved invoices.
    const documentsForDuplicates = invoiceHeaders.map((header) => {
      const fields = header.fields as { supplier?: { value: string | null }; documentNumber?: { value: string | null }; total?: { value: string | null } } | null;
      const supplierName = fields?.supplier?.value ?? null;
      if (supplierName) distinctSupplierNamesSeen.add(supplierName);
      return {
        id: header.documentId,
        contentHash: header.contentHash,
        supplierName,
        documentNumber: fields?.documentNumber?.value ?? null,
        total: fields?.total?.value ?? null,
      };
    });
    findings.push(...buildDuplicateInvoiceFindings(documentsForDuplicates));

    // --- Cross-supplier price findings — real confirmed quotes for the SAME product, SAME pack size.
    for (const product of products) {
      const confirmedMappings = await supplierProductRepository.findConfirmedForProduct(product.id);
      if (confirmedMappings.length < 2) continue;

      const quotes = [];
      for (const mapping of confirmedMappings) {
        const currentPrice = await supplierPriceRepository.findCurrent(mapping.id);
        if (!currentPrice) continue;
        const supplierName = supplierNameById.get(mapping.supplierId);
        if (!supplierName) continue;
        quotes.push({
          supplierName,
          unitPrice: currentPrice.unitPrice,
          packSize: mapping.packSize,
          packUnitCode: mapping.packUnitId ? (unitCodeById.get(mapping.packUnitId) ?? null) : null,
          evidenceDocumentId: currentPrice.sourceDocumentId ?? '',
        });
      }
      const crossSupplierFindings = buildCrossSupplierPriceFindings({ productName: product.name, quotes }).filter(
        (finding) => finding.evidenceDocumentIds.every((id) => id.length > 0)
      );
      findings.push(...crossSupplierFindings);
    }

    return {
      periodDays: input.days,
      supplierCount: distinctSupplierNamesSeen.size,
      findings: rankFindings(findings),
    };
  }),
});
