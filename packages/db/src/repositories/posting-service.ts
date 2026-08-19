import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Decimal } from 'decimal.js';
import * as schema from '../schema/index';
import { documentLinks, documents, organizations, outboxEvents, productVariants, supplierPrices, supplierProducts, stockMovements } from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';
import { generateId, detectPriceChange, type CurrencyCode } from '@retailos/domain';
import { MovementService } from './movement-service';
import { SupplierPerformanceEventRepository } from './supplier-performance-event-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

interface RawField {
  value: string | null;
}

interface RawLine {
  sku: RawField;
  quantity: RawField;
  unitPrice: RawField;
  lineTotal: RawField;
}

export interface PostingLineResult {
  lineIndex: number;
  status: 'POSTED' | 'SKIPPED_NO_MAPPING' | 'SKIPPED_UNPARSEABLE';
  productId?: string;
  supplierProductId?: string;
  lotId?: string;
}

export interface PostingResult {
  documentId: string;
  lines: PostingLineResult[];
}

/**
 * "the transactional heart." Approving an invoice is not filing a
 * document — it is a set of transactions: price history, product cost recompute, and a stock
 * receipt, all inside ONE transaction (I3, I8). If any step fails, NOTHING posts — a half-posted
 * invoice is worse than an unposted one, because the resulting numbers look plausible.
 *
 * Scope, confirmed with the user before building: the plan's full 8-step sketch also includes
 * matching to an EXISTING receipt, three-way match (PO/Receipt/Invoice), purchase spend facts, and
 * supplier performance events — all of which depend on `purchaseOrders`/`goodsReceipts`/
 * `invoiceMatch`/`supplierPerformanceEvents` tables that don't exist yet (a later milestone/Purchasing,
 * blocked behind this epic, not started). This class posts what a later milestone alone can support: price
 * history, cost recompute (via a real stock receipt), and provenance — the origin of the costing
 * chain (invoice -> cost). Three-way match and the rest are real a later milestone scope, not silently
 * dropped.
 *
 * A line with no CONFIRMED `supplier_products` mapping is skipped, not
 * blocking — confirmed with the user: approval must still succeed for a real, messy invoice where
 * not every line (a delivery fee, a decorative item) will ever have a product mapping. A skipped
 * line is a real, recorded "unknown," never a fabricated post (I7).
 *
 * Deliberately NOT built by composing `SupplierPriceRepository.recordNewPrice`/`LotRepository.
 * receive`/`MovementService.postMovement` as separate calls — each opens its OWN transaction
 * internally, so composing them from outside would silently run as several transactions, not one
 * atomic unit (the exact failure I8 exists to prevent, the same lesson this codebase has hit
 * repeatedly). This class opens exactly one transaction and writes every table directly inside it,
 * calling only `MovementService.postMovementInTx` — the one method on that class deliberately made
 * PUBLIC for exactly this composition case (an outer transaction posting a movement as part of a
 * larger atomic unit).
 */
export class PostingService {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('PostingService constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  /**
   * Posts an already-APPROVED document. The caller (the `documents.approve` procedure) is
   * responsible for the approve status transition itself — this method only does what the plan's
   * posting sketch describes, then moves the document to `POSTED`.
   */
  async postDocument(input: {
    documentId: string;
    storeId: string;
    fields: { supplier: RawField };
    lines: RawLine[];
    actorUserId: string;
  }): Promise<PostingResult> {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () => this.postDocumentInTx(tx, input))
    );
  }

  private async postDocumentInTx(
    tx: Tx,
    input: {
      documentId: string;
      storeId: string;
      fields: { supplier: RawField };
      lines: RawLine[];
      actorUserId: string;
    }
  ): Promise<PostingResult> {
    const supplierName = input.fields.supplier.value;
    const results: PostingLineResult[] = [];

    // The org's real base currency — every line below used to hardcode 'USD' for a real posted
    // supplier price regardless of organizations.baseCurrency, the same real bug fixed everywhere
    // else in this codebase's money-computing paths. Resolved once per document, not per line.
    const [orgRow] = await tx
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, this.organizationId));
    const currency = (orgRow?.baseCurrency ?? 'USD') as CurrencyCode;

    if (!supplierName) {
      // No supplier resolved at all — every line is unmappable by definition (earlier work's mapping
      // flow always resolves via an exact supplier name match). Still posts as an empty result,
      // never throws — an unposted line is a real "unknown," not a reason to fail the whole
      // approval a human already made.
      for (let i = 0; i < input.lines.length; i++) {
        results.push({ lineIndex: i, status: 'SKIPPED_NO_MAPPING' });
      }
      await tx.update(documents).set({ status: 'POSTED', updatedAt: new Date() }).where(eq(documents.id, input.documentId));
      return { documentId: input.documentId, lines: results };
    }

    for (let lineIndex = 0; lineIndex < input.lines.length; lineIndex++) {
      const line = input.lines[lineIndex]!;
      const result = await this.postLineInTx(tx, input.documentId, input.storeId, supplierName, line, lineIndex, input.actorUserId, currency);
      results.push(result);
    }

    await tx.update(documents).set({ status: 'POSTED', updatedAt: new Date() }).where(eq(documents.id, input.documentId));

    await tx.insert(outboxEvents).values({
      id: generateId(),
      organizationId: this.organizationId,
      aggregateType: 'document',
      aggregateId: input.documentId,
      eventType: 'document.posted',
      payload: { documentId: input.documentId, lines: results },
    });

    return { documentId: input.documentId, lines: results };
  }

  private async postLineInTx(
    tx: Tx,
    documentId: string,
    storeId: string,
    supplierName: string,
    line: RawLine,
    lineIndex: number,
    actorUserId: string,
    currency: CurrencyCode
  ): Promise<PostingLineResult> {
    const sku = line.sku.value;
    const quantity = parseDecimal(line.quantity.value);
    const unitPrice = parseDecimal(line.unitPrice.value);
    if (!sku || quantity === null || unitPrice === null) {
      return { lineIndex, status: 'SKIPPED_UNPARSEABLE' };
    }

    const mappingRows = await tx
      .select()
      .from(supplierProducts)
      .innerJoin(schema.suppliers, eq(schema.suppliers.id, supplierProducts.supplierId))
      .where(
        and(
          eq(supplierProducts.organizationId, this.organizationId),
          eq(schema.suppliers.organizationId, this.organizationId),
          eq(schema.suppliers.name, supplierName),
          eq(supplierProducts.supplierSku, sku),
          eq(supplierProducts.isConfirmed, true)
        )
      );
    const mapping = mappingRows[0]?.supplier_products;
    if (!mapping) {
      return { lineIndex, status: 'SKIPPED_NO_MAPPING' };
    }

    const [defaultVariant] = await tx
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, mapping.productId), eq(productVariants.isDefault, true), isNull(productVariants.deletedAt)));
    if (!defaultVariant) {
      // A product with no default variant is a genuine data-integrity gap this task doesn't fix —
      // skip this line rather than guess a variant, same "unknown, not a guess" discipline (I7).
      return { lineIndex, status: 'SKIPPED_NO_MAPPING', productId: mapping.productId, supplierProductId: mapping.id };
    }

    // 1. Price history — closes the currently-open row and inserts a fresh one, mirroring
    // SupplierPriceRepository.recordNewPrice's own logic exactly (that method can't be called
    // directly: it opens its own transaction).
    const now = new Date();
    const [currentPrice] = await tx
      .select()
      .from(supplierPrices)
      .where(and(eq(supplierPrices.supplierProductId, mapping.id), isNull(supplierPrices.validTo)));
    if (currentPrice) {
      await tx.update(supplierPrices).set({ validTo: now }).where(eq(supplierPrices.id, currentPrice.id));
    }
    const newPriceId = generateId();
    await tx.insert(supplierPrices).values({
      id: newPriceId,
      supplierProductId: mapping.id,
      unitPrice: unitPrice.toFixed(4),
      currency,
      validFrom: now,
      sourceDocumentId: documentId,
    });

    // a real price change is only worth surfacing when it crosses the
    // threshold `detectPriceChange` applies — never on every single post, which is what this code
    // did before earlier work (an unconditional `supplier.price_changed` outbox event on every line,
    // regardless of whether the price actually moved). Only runs when a real prior price existed —
    // the FIRST price for a supplier product is a baseline being established, not a "change."
    if (currentPrice) {
      const trailingSince = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      const [receiptTotal] = await tx
        .select({ total: sql<string | null>`sum(${stockMovements.quantity})` })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.organizationId, this.organizationId),
            eq(stockMovements.productId, mapping.productId),
            eq(stockMovements.movementType, 'RECEIPT'),
            gte(stockMovements.occurredAt, trailingSince)
          )
        );
      const trailing12moQuantity = receiptTotal?.total !== null && receiptTotal?.total !== undefined ? new Decimal(receiptTotal.total) : null;

      const priceChange = detectPriceChange({
        oldUnitPrice: new Decimal(currentPrice.unitPrice),
        newUnitPrice: unitPrice,
        trailing12moQuantity,
      });

      if (priceChange.isSignificantChange) {
        await SupplierPerformanceEventRepository.recordInTx(tx, this.organizationId, {
          organizationId: this.organizationId,
          supplierId: mapping.supplierId,
          eventType: 'PRICE_CHANGE',
          documentId,
          productId: mapping.productId,
          expectedValue: new Decimal(currentPrice.unitPrice).toFixed(6),
          actualValue: unitPrice.toFixed(6),
          ...(priceChange.annualizedImpact !== 'unknown' ? { variance: priceChange.annualizedImpact.toFixed(6) } : {}),
          occurredAt: now,
        });

        await tx.insert(outboxEvents).values({
          id: generateId(),
          organizationId: this.organizationId,
          aggregateType: 'supplier_product',
          aggregateId: mapping.id,
          eventType: 'supplier.price_changed',
          payload: {
            supplierProductId: mapping.id,
            oldUnitPrice: currentPrice.unitPrice,
            newUnitPrice: unitPrice.toFixed(4),
            percentChange: priceChange.percentChange?.toFixed(6) ?? null,
            annualizedImpact: priceChange.annualizedImpact !== 'unknown' ? priceChange.annualizedImpact.toFixed(4) : null,
            documentId,
          },
        });
      }
    }

    // 2. Stock receipt (creates a lot + posts a RECEIPT movement, which recomputes stock_levels'
    // moving-average cost — this system's real "product cost", per stock_levels.avgUnitCost, since
    // no separate products.cost column exists). Quantity/cost both convert from the supplier's pack
    // unit to the product's base unit via conversionToBase, the same formula recipes.cost already
    // uses (unitPrice is per PACK; base-unit cost = unitPrice / conversionToBase).
    const conversionToBase = mapping.conversionToBase !== null ? new Decimal(mapping.conversionToBase) : new Decimal(1);
    const baseQuantity = quantity.times(conversionToBase);
    const baseUnitCost = unitPrice.dividedBy(conversionToBase);

    const lotId = generateId();
    await tx.insert(schema.lots).values({
      id: lotId,
      organizationId: this.organizationId,
      storeId,
      productId: mapping.productId,
      variantId: defaultVariant.id,
      receivedAt: now,
      initialQuantity: baseQuantity.toFixed(6),
      remainingQuantity: baseQuantity.toFixed(6),
      unitCost: baseUnitCost.toFixed(4),
      currency,
      supplierId: mapping.supplierId,
      sourceDocumentId: documentId,
    });

    // MovementService's constructor takes a plain Db, but that argument is only ever used by its
    // OWN transaction-opening methods (postMovement/consumeFefo/logWaste) — postMovementInTx, the
    // one method called here, only ever uses the `tx` passed explicitly as its first argument.
    // Passing `tx` here satisfies the constructor without a second, separate connection.
    const movementService = new MovementService(tx as unknown as Db, this.organizationId);
    const movement = await movementService.postMovementInTx(tx, {
      storeId,
      productId: mapping.productId,
      variantId: defaultVariant.id,
      lotId,
      movementType: 'RECEIPT',
      quantity: baseQuantity.toFixed(6),
      unitCost: baseUnitCost.toFixed(4),
      currency,
      occurredAt: now,
      sourceType: 'document',
      sourceId: documentId,
      actorUserId,
    });

    // 3. Provenance — every entity this line's posting touched, so a margin figure can drill back
    // to the invoice image that set the cost.
    await tx
      .insert(documentLinks)
      .values([
        { id: generateId(), organizationId: this.organizationId, documentId, entityType: 'supplier_price', entityId: newPriceId, relationship: 'PRICE_SOURCE' },
        { id: generateId(), organizationId: this.organizationId, documentId, entityType: 'lot', entityId: lotId, relationship: 'STOCK_RECEIPT' },
        { id: generateId(), organizationId: this.organizationId, documentId, entityType: 'stock_movement', entityId: movement.movement.id, relationship: 'STOCK_RECEIPT' },
      ])
      .onConflictDoNothing({ target: [documentLinks.documentId, documentLinks.entityType, documentLinks.entityId, documentLinks.relationship] });

    // `supplier.price_changed` moved above — now emitted ONLY when detectPriceChange
    // confirms a real, threshold-crossing change, not unconditionally on every posted line.
    await tx.insert(outboxEvents).values({
      id: generateId(),
      organizationId: this.organizationId,
      aggregateType: 'product',
      aggregateId: mapping.productId,
      eventType: 'cost.updated',
      payload: { productId: mapping.productId, storeId, documentId },
    });

    return { lineIndex, status: 'POSTED', productId: mapping.productId, supplierProductId: mapping.id, lotId };
  }
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
