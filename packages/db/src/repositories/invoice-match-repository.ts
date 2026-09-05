import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Decimal } from 'decimal.js';
import {
  classifyLineMatch,
  highestSeverity,
  generateId,
  computeMatchDollarImpact,
  DEFAULT_MATCH_TOLERANCES,
  type MatchTolerances,
  type VarianceSeverity,
  type LineForDollarImpact,
  type VarianceType,
} from '@retailos/domain';
import * as schema from '../schema/index';
import {
  auditLogs,
  invoiceMatches,
  invoiceMatchLines,
  outboxEvents,
  goodsReceiptLines,
  goodsReceipts,
  organizations,
  products,
  purchaseOrderLines,
  suppliers,
  supplierProducts,
} from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';
import { SupplierPerformanceEventRepository } from './supplier-performance-event-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

interface RawField {
  value: string | null;
}

interface RawInvoiceLine {
  sku: RawField;
  quantity: RawField;
  unitPrice: RawField;
}

export interface InvoiceMatchLineResult {
  lineIndex: number;
  varianceType: string;
  varianceSeverity: VarianceSeverity;
  explanation: string;
}

export interface InvoiceMatchResult {
  id: string;
  documentId: string;
  purchaseOrderId: string | null;
  highestSeverity: VarianceSeverity;
  lines: InvoiceMatchLineResult[];
}

/** Mirrors `packages/domain/src/documents/validation.ts`'s own parser exactly — never coerces an unparseable value to 0 (I7). */
const parseDecimal = (raw: string | null): Decimal | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed.replace(/[,$€£]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const value = new Decimal(normalized);
  return value.isFinite() ? value : null;
};

/**
 * "the financial control that catches real money."
 * Matches an already-POSTED invoice document's lines against real PO/receipt lines, classifies
 * each line's variance (packages/domain's pure `classifyLineMatch`), and persists the result.
 *
 * A plain class opening exactly ONE transaction and writing every table directly inside it,
 * matching `PostingService`'s own established precedent — this project's repeated lesson that
 * repository methods which each open their own transaction cannot be composed from an outer
 * function into one atomic unit (I8). `runMatch` is the sole entry point.
 *
 * SKU resolution matches `PostingService.postLineInTx`'s own exact logic: exact supplier-name
 * match, then a CONFIRMED `supplier_products.supplierSku` mapping — an unconfirmed or fuzzy
 * mapping never feeds a financial-control decision, the same discipline the validation gates'
 * price-anomaly check already established. A line with no resolvable SKU/mapping is classified
 * `UNORDERED_ITEM` by the domain function itself (a `null` candidate), never silently dropped.
 */
export class InvoiceMatchRepository {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('InvoiceMatchRepository constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  async runMatch(input: {
    documentId: string;
    storeId: string;
    supplierName: string | null;
    lines: RawInvoiceLine[];
  }): Promise<InvoiceMatchResult> {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () => this.runMatchInTx(tx, input))
    );
  }

  private async runMatchInTx(
    tx: Tx,
    input: { documentId: string; storeId: string; supplierName: string | null; lines: RawInvoiceLine[] }
  ): Promise<InvoiceMatchResult> {
    const tolerances = await this.resolveTolerances(tx);

    let supplierId: string | null = null;
    if (input.supplierName) {
      const [supplierRow] = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(and(eq(suppliers.organizationId, this.organizationId), eq(suppliers.name, input.supplierName)));
      supplierId = supplierRow?.id ?? null;
    }

    const lineResults: InvoiceMatchLineResult[] = [];
    const lineInsertValues: (typeof invoiceMatchLines.$inferInsert)[] = [];
    let resolvedPurchaseOrderId: string | null = null;

    for (let lineIndex = 0; lineIndex < input.lines.length; lineIndex++) {
      const line = input.lines[lineIndex]!;
      const quantity = parseDecimal(line.quantity.value);
      const unitPrice = parseDecimal(line.unitPrice.value);
      const sku = line.sku.value;

      const candidate = await this.resolveCandidate(tx, supplierId, sku);
      if (candidate.purchaseOrderId !== null) {
        resolvedPurchaseOrderId = candidate.purchaseOrderId;
      }

      const classification = classifyLineMatch(
        { quantity, unitPrice },
        {
          poUnitPrice: candidate.poUnitPrice,
          receivedQuantity: candidate.receivedQuantity,
          receiptFound: candidate.receiptFound,
        },
        tolerances
      );

      lineResults.push({
        lineIndex,
        varianceType: classification.varianceType,
        varianceSeverity: classification.varianceSeverity,
        explanation: classification.explanation,
      });

      lineInsertValues.push({
        id: generateId(),
        organizationId: this.organizationId,
        invoiceMatchId: '', // filled in after the match row's id is known, below
        invoiceLineIndex: lineIndex.toString(),
        purchaseOrderLineId: candidate.purchaseOrderLineId,
        goodsReceiptLineId: candidate.goodsReceiptLineId,
        productId: candidate.productId,
        invoiceSku: sku,
        invoiceQuantity: quantity?.toFixed(6) ?? null,
        invoiceUnitPrice: unitPrice?.toFixed(4) ?? null,
        poUnitPrice: candidate.poUnitPrice?.toFixed(4) ?? null,
        receivedQuantity: candidate.receivedQuantity?.toFixed(6) ?? null,
        priceVariance: classification.priceVariance?.toFixed(4) ?? null,
        quantityVariance: classification.quantityVariance?.toFixed(6) ?? null,
        varianceType: classification.varianceType,
        varianceSeverity: classification.varianceSeverity,
        explanation: classification.explanation,
      });
    }

    const overallSeverity = highestSeverity(lineResults.map((l) => l.varianceSeverity));

    const matchId = generateId();
    const matchedAt = new Date();
    // supplierId is required on the row (a match must belong to a real supplier); when the
    // invoice's own supplier name didn't resolve at all, every line is necessarily UNORDERED_ITEM
    // already (no candidate could be resolved without a supplier), so this only ever happens
    // together with an already-honest "everything unmatched" result, never a silently-guessed supplier.
    const resolvedSupplierId = supplierId ?? (await this.requireFallbackSupplierId(tx, input.storeId));
    await tx.insert(invoiceMatches).values({
      id: matchId,
      organizationId: this.organizationId,
      storeId: input.storeId,
      documentId: input.documentId,
      supplierId: resolvedSupplierId,
      purchaseOrderId: resolvedPurchaseOrderId,
      highestSeverity: overallSeverity,
      matchedAt,
    });

    for (const values of lineInsertValues) {
      await tx.insert(invoiceMatchLines).values({ ...values, invoiceMatchId: matchId });
    }

    // PRICE_VARIANCE: one event per REAL matched line whose classification actually found a price
    // variance — never for UNORDERED_ITEM/INVOICED_NOT_RECEIVED lines, which have no real poUnitPrice
    // to compare against (classifyLineMatch itself never computes a priceVariance for those cases).
    for (let lineIndex = 0; lineIndex < lineResults.length; lineIndex++) {
      const result = lineResults[lineIndex]!;
      const values = lineInsertValues[lineIndex]!;
      const poUnitPrice = values.poUnitPrice;
      const invoiceUnitPrice = values.invoiceUnitPrice;
      if (result.varianceType === 'PRICE_VARIANCE' && poUnitPrice !== null && poUnitPrice !== undefined && invoiceUnitPrice !== null && invoiceUnitPrice !== undefined) {
        await SupplierPerformanceEventRepository.recordInTx(tx, this.organizationId, {
          organizationId: this.organizationId,
          supplierId: resolvedSupplierId,
          eventType: 'PRICE_VARIANCE',
          documentId: input.documentId,
          ...(values.productId !== null && values.productId !== undefined ? { productId: values.productId } : {}),
          expectedValue: poUnitPrice,
          actualValue: invoiceUnitPrice,
          ...(values.priceVariance !== null && values.priceVariance !== undefined ? { variance: values.priceVariance } : {}),
          occurredAt: matchedAt,
        });
      }
    }

    // INVOICE_CLEAN/INVOICE_ERROR: one event for the whole invoice (the design's "invoice
    // accuracy = clean_invoices / total_invoices" is a per-INVOICE rate, not per-line) — clean only
    // when every real line matched within tolerance (`overallSeverity === 'NONE'`), matching
    // `findPending`'s own established "highestSeverity is the worst thing on this invoice" reading.
    await SupplierPerformanceEventRepository.recordInTx(tx, this.organizationId, {
      organizationId: this.organizationId,
      supplierId: resolvedSupplierId,
      eventType: overallSeverity === 'NONE' ? 'INVOICE_CLEAN' : 'INVOICE_ERROR',
      documentId: input.documentId,
      occurredAt: matchedAt,
    });

    await tx.insert(outboxEvents).values({
      id: generateId(),
      organizationId: this.organizationId,
      aggregateType: 'invoice_match',
      aggregateId: matchId,
      eventType: 'match.variance_detected',
      payload: {
        invoiceMatchId: matchId,
        documentId: input.documentId,
        highestSeverity: overallSeverity,
        lineCount: lineResults.length,
        varianceLineCount: lineResults.filter((l) => l.varianceType !== 'CLEAN').length,
      },
    });

    return { id: matchId, documentId: input.documentId, purchaseOrderId: resolvedPurchaseOrderId, highestSeverity: overallSeverity, lines: lineResults };
  }

  /**
   * "Avoid alert fatigue on cents": reads this org's real
   * `organizations.match*Tolerance*` columns, falling back to `DEFAULT_MATCH_TOLERANCES` PER FIELD
   * when a column is `null` — an org that has only ever set a price tolerance still gets the real
   * default quantity tolerance, not an accidentally-zero one. Never guesses a tolerance from a
   * missing organization row (I7 would forbid it), but that case cannot occur here: `runMatchInTx`
   * only ever runs inside a transaction already scoped to a real, existing `organizationId`.
   */
  private async resolveTolerances(tx: Tx): Promise<MatchTolerances> {
    const [org] = await tx
      .select({
        matchPriceTolerancePercent: organizations.matchPriceTolerancePercent,
        matchPriceToleranceAbsolute: organizations.matchPriceToleranceAbsolute,
        matchQuantityTolerancePercent: organizations.matchQuantityTolerancePercent,
      })
      .from(organizations)
      .where(eq(organizations.id, this.organizationId));

    return {
      priceTolerancePercent: org?.matchPriceTolerancePercent !== null && org?.matchPriceTolerancePercent !== undefined
        ? new Decimal(org.matchPriceTolerancePercent)
        : DEFAULT_MATCH_TOLERANCES.priceTolerancePercent,
      priceToleranceAbsolute: org?.matchPriceToleranceAbsolute !== null && org?.matchPriceToleranceAbsolute !== undefined
        ? new Decimal(org.matchPriceToleranceAbsolute)
        : DEFAULT_MATCH_TOLERANCES.priceToleranceAbsolute,
      quantityTolerancePercent: org?.matchQuantityTolerancePercent !== null && org?.matchQuantityTolerancePercent !== undefined
        ? new Decimal(org.matchQuantityTolerancePercent)
        : DEFAULT_MATCH_TOLERANCES.quantityTolerancePercent,
    };
  }

  /**
   * A document has a real `supplierId` FK requirement it cannot violate, but this repository's own
   * `supplierId` resolution can genuinely fail (unresolvable supplier name — every line will be
   * UNORDERED_ITEM already). Falls back to a real, deterministic choice: the supplier most recently
   * associated with THIS store via any confirmed supplier_products row, or — if none exists at
   * all — throws rather than fabricate a supplier reference (I7: an invoice match cannot exist
   * without SOME real supplier row to point at, and guessing one would corrupt drill-through).
   */
  private async requireFallbackSupplierId(tx: Tx, storeId: string): Promise<string> {
    const [row] = await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.organizationId, this.organizationId))
      .orderBy(suppliers.createdAt)
      .limit(1);
    if (!row) {
      throw new UnresolvableInvoiceSupplierError(
        'Could not resolve a supplier for this invoice match — no supplier exists in this organization at all.'
      );
    }
    void storeId;
    return row.id;
  }

  /**
   * Resolves the real PO line / receipt line pair for one invoice line's SKU, matching
   * `PostingService.postLineInTx`'s exact SKU-resolution logic (exact supplier name + a CONFIRMED
   * `supplier_products.supplierSku` mapping). Prefers a receipt line that already carries a
   * `purchaseOrderLineId` (the normal PO-backed path) but also matches a receipt line with NO PO at
   * all purely by product — a walk-in receipt still has a real product,
   * so an invoice for that same product can still be reconciled against it even with no PO involved.
   */
  private async resolveCandidate(
    tx: Tx,
    supplierId: string | null,
    sku: string | null
  ): Promise<{
    purchaseOrderId: string | null;
    purchaseOrderLineId: string | null;
    goodsReceiptLineId: string | null;
    productId: string | null;
    poUnitPrice: Decimal | null;
    receivedQuantity: Decimal | null;
    receiptFound: boolean;
  }> {
    const empty = {
      purchaseOrderId: null,
      purchaseOrderLineId: null,
      goodsReceiptLineId: null,
      productId: null,
      poUnitPrice: null,
      receivedQuantity: null,
      receiptFound: false,
    };
    if (!supplierId || !sku) return empty;

    const [mapping] = await tx
      .select({
        productId: supplierProducts.productId,
        conversionToBase: supplierProducts.conversionToBase,
      })
      .from(supplierProducts)
      .where(
        and(
          eq(supplierProducts.organizationId, this.organizationId),
          eq(supplierProducts.supplierId, supplierId),
          eq(supplierProducts.supplierSku, sku),
          eq(supplierProducts.isConfirmed, true)
        )
      );
    if (!mapping) return empty;

    // The most recent real receipt line for this product from this supplier — joined to its PO
    // line (if any) for the ordered price. `goods_receipts.supplierId` is the receipt's own real
    // supplier column (set at confirmReceipt time), not derived from the PO, so this also matches
    // walk-in/no-PO receipts correctly.
    const [receiptRow] = await tx
      .select({
        goodsReceiptLineId: goodsReceiptLines.id,
        purchaseOrderLineId: goodsReceiptLines.purchaseOrderLineId,
        receivedQuantityBaseUnits: goodsReceiptLines.receivedQuantityBaseUnits,
        purchaseOrderId: purchaseOrderLines.purchaseOrderId,
        poUnitPrice: purchaseOrderLines.unitPrice,
        poConversionToBase: purchaseOrderLines.conversionToBase,
      })
      .from(goodsReceiptLines)
      .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.goodsReceiptId))
      .leftJoin(purchaseOrderLines, eq(purchaseOrderLines.id, goodsReceiptLines.purchaseOrderLineId))
      .where(
        and(
          eq(goodsReceiptLines.organizationId, this.organizationId),
          eq(goodsReceiptLines.productId, mapping.productId),
          eq(goodsReceipts.supplierId, supplierId)
        )
      )
      .orderBy(sql`${goodsReceiptLines.createdAt} DESC`)
      .limit(1);

    if (receiptRow) {
      // Invoice quantities and PO prices are expressed in supplier/order units (bags, cases,
      // packs), while goods receipts deliberately persist base units for stock posting. Compare
      // like with like by converting the received base quantity back to the frozen PO order unit.
      // A walk-in receipt has no PO line, so fall back to the confirmed supplier mapping's pack
      // conversion; a legacy mapping with no conversion continues to mean order unit == base unit.
      const receivedBase = new Decimal(receiptRow.receivedQuantityBaseUnits);
      const conversionToBaseRaw = receiptRow.poConversionToBase ?? mapping.conversionToBase;
      const conversionToBase = conversionToBaseRaw === null ? null : new Decimal(conversionToBaseRaw);
      // A conversion factor of zero or less is invalid data, not a real order-unit relationship —
      // dividing by it would throw (zero) or silently flip the sign (negative). Neither is a number
      // this function should ever hand back with confidence, so it degrades to unknown (I7) instead.
      const receivedOrderUnits =
        conversionToBase === null
          ? receivedBase
          : conversionToBase.lessThanOrEqualTo(0)
            ? null
            : receivedBase.dividedBy(conversionToBase);

      return {
        purchaseOrderId: receiptRow.purchaseOrderId ?? null,
        purchaseOrderLineId: receiptRow.purchaseOrderLineId ?? null,
        goodsReceiptLineId: receiptRow.goodsReceiptLineId,
        productId: mapping.productId,
        poUnitPrice: receiptRow.poUnitPrice !== null ? new Decimal(receiptRow.poUnitPrice) : null,
        receivedQuantity: receivedOrderUnits,
        receiptFound: true,
      };
    }

    // No receipt at all — check for a real, un-received PO line for this product/supplier, so a
    // genuinely ordered-but-never-received item is classified INVOICED_NOT_RECEIVED (the plan's
    // high-priority fraud/error flag), not the weaker UNORDERED_ITEM (no order exists at all).
    const [poLineRow] = await tx
      .select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId, unitPrice: purchaseOrderLines.unitPrice })
      .from(purchaseOrderLines)
      .where(and(eq(purchaseOrderLines.organizationId, this.organizationId), eq(purchaseOrderLines.productId, mapping.productId)))
      .orderBy(sql`${purchaseOrderLines.createdAt} DESC`)
      .limit(1);

    if (poLineRow) {
      return {
        purchaseOrderId: poLineRow.purchaseOrderId,
        purchaseOrderLineId: null,
        goodsReceiptLineId: null,
        productId: mapping.productId,
        poUnitPrice: new Decimal(poLineRow.unitPrice),
        receivedQuantity: null,
        receiptFound: false,
      };
    }

    return { ...empty, productId: mapping.productId };
  }

  async findById(id: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const rows = await tx
          .select()
          .from(invoiceMatches)
          .where(and(eq(invoiceMatches.organizationId, this.organizationId), eq(invoiceMatches.id, id)));
        return rows[0] ?? null;
      })
    );
  }

  async findByDocumentId(documentId: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const rows = await tx
          .select()
          .from(invoiceMatches)
          .where(and(eq(invoiceMatches.organizationId, this.organizationId), eq(invoiceMatches.documentId, documentId)));
        return rows[0] ?? null;
      })
    );
  }

  /**
   * Left-joins `products` for a real name — `invoiceMatchLines.productId` is nullable (an
   * unordered/unreceived item may never resolve to a real product at all), so `productName` is
   * `null` for exactly those real "no match" cases, never a fabricated placeholder. The three-way
   * match detail screen's own "unreadable SKU, no product name at all" gap this join closes.
   */
  async findLines(invoiceMatchId: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select({
            id: invoiceMatchLines.id,
            organizationId: invoiceMatchLines.organizationId,
            invoiceMatchId: invoiceMatchLines.invoiceMatchId,
            invoiceLineIndex: invoiceMatchLines.invoiceLineIndex,
            purchaseOrderLineId: invoiceMatchLines.purchaseOrderLineId,
            goodsReceiptLineId: invoiceMatchLines.goodsReceiptLineId,
            productId: invoiceMatchLines.productId,
            productName: products.name,
            invoiceSku: invoiceMatchLines.invoiceSku,
            invoiceQuantity: invoiceMatchLines.invoiceQuantity,
            invoiceUnitPrice: invoiceMatchLines.invoiceUnitPrice,
            poUnitPrice: invoiceMatchLines.poUnitPrice,
            receivedQuantity: invoiceMatchLines.receivedQuantity,
            priceVariance: invoiceMatchLines.priceVariance,
            quantityVariance: invoiceMatchLines.quantityVariance,
            varianceType: invoiceMatchLines.varianceType,
            varianceSeverity: invoiceMatchLines.varianceSeverity,
            explanation: invoiceMatchLines.explanation,
            createdAt: invoiceMatchLines.createdAt,
            updatedAt: invoiceMatchLines.updatedAt,
          })
          .from(invoiceMatchLines)
          .leftJoin(products, eq(products.id, invoiceMatchLines.productId))
          .where(and(eq(invoiceMatchLines.organizationId, this.organizationId), eq(invoiceMatchLines.invoiceMatchId, invoiceMatchId)))
          .orderBy(invoiceMatchLines.invoiceLineIndex)
      )
    );
  }

  /**
   * The review queue's real read path. Confirmed with the user: a CLEAN match
   * (`highestSeverity = 'NONE'`, every line matched within tolerance) never appears here — a queue
   * full of clean invoices defeats the point of earlier work's configurable tolerances, which exist
   * specifically to keep alert-worthy variances from being drowned out by noise. `status = 'PENDING'`
   * alone is not enough to express this, since a match can be `PENDING` and still have zero real
   * variance; the `highestSeverity <> 'NONE'` predicate is what actually encodes "worth a manager's
   * attention," using the same column `classifyLineMatch`/`highestSeverity` already computed.
   *
   * Joins `suppliers` for a real name (the queue's own "no supplier column at all" gap) and
   * batch-fetches every returned match's lines in one second query (never N+1) to compute each
   * match's real `dollarImpact` via `computeMatchDollarImpact` (I2 — the exact same pure function
   * the match detail page would use, not a parallel formula re-derived here).
   */
  async findPending(storeId?: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const base = and(
          eq(invoiceMatches.organizationId, this.organizationId),
          eq(invoiceMatches.status, 'PENDING'),
          sql`${invoiceMatches.highestSeverity} IS NOT NULL AND ${invoiceMatches.highestSeverity} <> 'NONE'`
        );
        const matches = await tx
          .select({
            id: invoiceMatches.id,
            organizationId: invoiceMatches.organizationId,
            storeId: invoiceMatches.storeId,
            documentId: invoiceMatches.documentId,
            supplierId: invoiceMatches.supplierId,
            supplierName: suppliers.name,
            purchaseOrderId: invoiceMatches.purchaseOrderId,
            status: invoiceMatches.status,
            highestSeverity: invoiceMatches.highestSeverity,
            matchedAt: invoiceMatches.matchedAt,
          })
          .from(invoiceMatches)
          .innerJoin(suppliers, eq(suppliers.id, invoiceMatches.supplierId))
          .where(storeId !== undefined ? and(base, eq(invoiceMatches.storeId, storeId)) : base)
          .orderBy(
            sql`CASE ${invoiceMatches.highestSeverity} WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END`,
            sql`${invoiceMatches.matchedAt} DESC`
          );

        if (matches.length === 0) return [];

        const matchIds = matches.map((m) => m.id);
        const allLines = await tx
          .select({
            invoiceMatchId: invoiceMatchLines.invoiceMatchId,
            varianceType: invoiceMatchLines.varianceType,
            priceVariance: invoiceMatchLines.priceVariance,
            quantityVariance: invoiceMatchLines.quantityVariance,
            invoiceQuantity: invoiceMatchLines.invoiceQuantity,
            invoiceUnitPrice: invoiceMatchLines.invoiceUnitPrice,
          })
          .from(invoiceMatchLines)
          .where(and(eq(invoiceMatchLines.organizationId, this.organizationId), inArray(invoiceMatchLines.invoiceMatchId, matchIds)));

        const linesByMatch = new Map<string, LineForDollarImpact[]>();
        for (const line of allLines) {
          const forImpact: LineForDollarImpact = {
            varianceType: line.varianceType as VarianceType,
            priceVariance: line.priceVariance !== null ? new Decimal(line.priceVariance) : null,
            quantityVariance: line.quantityVariance !== null ? new Decimal(line.quantityVariance) : null,
            invoiceQuantity: line.invoiceQuantity !== null ? new Decimal(line.invoiceQuantity) : null,
            invoiceUnitPrice: line.invoiceUnitPrice !== null ? new Decimal(line.invoiceUnitPrice) : null,
          };
          const existing = linesByMatch.get(line.invoiceMatchId);
          if (existing) existing.push(forImpact);
          else linesByMatch.set(line.invoiceMatchId, [forImpact]);
        }

        return matches.map((match) => ({
          ...match,
          dollarImpact: computeMatchDollarImpact(linesByMatch.get(match.id) ?? []),
        }));
      })
    );
  }

  /**
   * the one real resolution action, confirmed with the user — `PENDING` moves straight to
   * `RESOLVED` with a REQUIRED note (never optional, unlike `purchase_orders.rejectionReason`'s own
   * optional precedent — a variance resolution needs an audit trail explaining where the money/
   * quantity discrepancy actually went, not just that someone looked at it). Refuses to resolve a
   * match that isn't `PENDING` (already resolved, or doesn't exist in this org) — returns a typed
   * result rather than silently no-op'ing, matching `PurchaseOrderRepository.addLine`'s own
   * `NOT_FOUND`/`NOT_EDITABLE` precedent so the caller can tell "doesn't exist" from "already done."
   */
  async resolve(id: string, resolvedByUserId: string, resolutionNotes: string): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_RESOLVED' }> {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const [row] = await tx
          .select({ status: invoiceMatches.status })
          .from(invoiceMatches)
          .where(and(eq(invoiceMatches.organizationId, this.organizationId), eq(invoiceMatches.id, id)));
        if (!row) return { ok: false, reason: 'NOT_FOUND' };
        if (row.status === 'RESOLVED') return { ok: false, reason: 'ALREADY_RESOLVED' };

        await tx
          .update(invoiceMatches)
          .set({ status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId, resolutionNotes, updatedAt: new Date() })
          .where(and(eq(invoiceMatches.organizationId, this.organizationId), eq(invoiceMatches.id, id)));

        await tx.insert(auditLogs).values({
          id: generateId(),
          organizationId: this.organizationId,
          actorUserId: resolvedByUserId,
          actorType: 'USER',
          action: 'invoice_match.resolved',
          entityType: 'invoice_match',
          entityId: id,
          metadata: { resolutionNotes },
        });

        return { ok: true };
      })
    );
  }

  /**
   * `price_variance_total`'s real input — every invoice line matched to one supplier
   * in a period with both `priceVariance` and `invoiceQuantity` present. `classifyLineMatch`
   * populates these two fields independently (one gated on whether a PO price was found, the other
   * on whether the invoice line itself parsed) — see `three-way-match.ts` — so both are checked
   * explicitly rather than assuming one implies the other. `matchedAt` (the invoice match's own
   * timestamp) is the period anchor.
   */
  async findPriceVarianceLines(supplierId: string, from: Date, to: Date) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select({
            priceVariance: invoiceMatchLines.priceVariance,
            invoiceQuantity: invoiceMatchLines.invoiceQuantity,
          })
          .from(invoiceMatchLines)
          .innerJoin(invoiceMatches, eq(invoiceMatches.id, invoiceMatchLines.invoiceMatchId))
          .where(
            and(
              eq(invoiceMatchLines.organizationId, this.organizationId),
              eq(invoiceMatches.organizationId, this.organizationId),
              eq(invoiceMatches.supplierId, supplierId),
              isNotNull(invoiceMatchLines.priceVariance),
              isNotNull(invoiceMatchLines.invoiceQuantity),
              gte(invoiceMatches.matchedAt, from),
              lt(invoiceMatches.matchedAt, to)
            )
          )
      )
    );
  }
}

export class UnresolvableInvoiceSupplierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvableInvoiceSupplierError';
  }
}
