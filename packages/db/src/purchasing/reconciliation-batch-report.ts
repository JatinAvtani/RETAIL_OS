import { and, desc, eq, gte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Decimal } from 'decimal.js';
import {
  buildReconciliationBatchReport,
  type ReconciledLine,
  type ReconciliationBatchReport,
  type VarianceType,
  type VarianceSeverity,
} from '@retailos/domain';
import * as schema from '../schema/index';
import { invoiceMatches, invoiceMatchLines, products, suppliers } from '../schema/index';
import { withTenantContext } from '../tenant-context';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * the real data-gathering half of the Razorpay "AI Finance Controller" batch-
 * reconciliation report. Deliberately a NEW file rather than an addition to
 * `invoice-match-repository.ts` — that file was mid-edit by a concurrent session building the
 * variance-queue/invoice-match-detail UI when this was written; keeping this in its own file
 * avoids a real concurrent-edit conflict on a shared file, matching this codebase's own precedent
 * of `reorder-suggestions.ts` living separately from `PurchaseOrderRepository` for the same reason
 * (a distinct read/report concern, not a repository's own CRUD surface).
 *
 * Reads ALREADY-persisted `invoice_match_lines` rows — every one written by the real
 * `InvoiceMatchRepository.runMatch` at real invoice-posting time (`classifyLineMatch`, I2) — across
 * however many real invoices the org has, never re-running matching logic here. This is the
 * "aggregate report over already-matched real data" design, confirmed with the user: honest
 * (100% real production code paths, not a demo-only re-implementation) and fast to build correctly.
 */
export const gatherReconciliationBatch = async (
  db: Db,
  organizationId: string,
  options: { storeId?: string; since?: Date; limit?: number } = {}
): Promise<ReconciliationBatchReport> => {
  const lines = await db.transaction((tx) =>
    withTenantContext(tx, organizationId, async () => {
      const base = and(
        eq(invoiceMatchLines.organizationId, organizationId),
        options.storeId !== undefined ? eq(invoiceMatches.storeId, options.storeId) : undefined,
        options.since !== undefined ? gte(invoiceMatches.matchedAt, options.since) : undefined
      );

      const rows = await tx
        .select({
          lineId: invoiceMatchLines.id,
          invoiceMatchId: invoiceMatchLines.invoiceMatchId,
          supplierName: suppliers.name,
          productName: products.name,
          varianceType: invoiceMatchLines.varianceType,
          varianceSeverity: invoiceMatchLines.varianceSeverity,
          priceVariance: invoiceMatchLines.priceVariance,
          quantityVariance: invoiceMatchLines.quantityVariance,
          invoiceQuantity: invoiceMatchLines.invoiceQuantity,
          invoiceUnitPrice: invoiceMatchLines.invoiceUnitPrice,
          explanation: invoiceMatchLines.explanation,
        })
        .from(invoiceMatchLines)
        .innerJoin(invoiceMatches, eq(invoiceMatches.id, invoiceMatchLines.invoiceMatchId))
        .innerJoin(suppliers, eq(suppliers.id, invoiceMatches.supplierId))
        .leftJoin(products, eq(products.id, invoiceMatchLines.productId))
        .where(base)
        .orderBy(desc(invoiceMatches.matchedAt))
        .limit(options.limit ?? 500);

      return rows;
    })
  );

  const reconciledLines: ReconciledLine[] = lines.map((r) => ({
    lineId: r.lineId,
    invoiceMatchId: r.invoiceMatchId,
    supplierName: r.supplierName,
    productName: r.productName,
    varianceType: r.varianceType as VarianceType,
    varianceSeverity: r.varianceSeverity as VarianceSeverity,
    priceVariance: r.priceVariance !== null ? new Decimal(r.priceVariance) : null,
    quantityVariance: r.quantityVariance !== null ? new Decimal(r.quantityVariance) : null,
    invoiceQuantity: r.invoiceQuantity !== null ? new Decimal(r.invoiceQuantity) : null,
    invoiceUnitPrice: r.invoiceUnitPrice !== null ? new Decimal(r.invoiceUnitPrice) : null,
    explanation: r.explanation,
  }));

  return buildReconciliationBatchReport(reconciledLines);
};
