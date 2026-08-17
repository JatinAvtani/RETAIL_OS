import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Decimal } from 'decimal.js';
import { generateId, applyPurchaseOrderTransition, type CurrencyCode, type PurchaseOrderStatus } from '@retailos/domain';
import * as schema from '../schema/index';
import {
  goodsReceipts,
  goodsReceiptLines,
  lots,
  organizations,
  purchaseOrders,
  purchaseOrderLines,
  outboxEvents,
  productVariants,
  type DiscrepancyCode,
} from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';
import { MovementService } from './movement-service';
import { SupplierPerformanceEventRepository } from './supplier-performance-event-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * `productId`/`variantId` are OPTIONAL on the input — when `purchaseOrderLineId` is given (the
 * normal case: receiving against a real PO), both are resolved server-side directly from that PO
 * line (`variantId` falling back to the product's default variant if the PO line never recorded
 * one), so the caller never needs to already know a product's internal variant id. Both are
 * REQUIRED when there is no `purchaseOrderLineId` (008-09's future receipt-without-PO scope) —
 * there is no PO line to resolve them from.
 */
export type ReceiveLineInput = {
  purchaseOrderLineId?: string;
  productId?: string;
  variantId?: string;
  receivedQuantityBaseUnits: string;
  baseUnitId?: string;
  unitCost?: string;
  currency?: string;
  lotNumber?: string;
  expiryDate?: string;
  discrepancyCode?: DiscrepancyCode;
  discrepancyNotes?: string;
  lineNumber: number;
};

/** A receipt line with neither a `purchaseOrderLineId` to resolve from nor an explicit `productId`/`variantId` has nothing to create a lot against — thrown, never guessed. */
export class MissingReceiveLineProductError extends Error {
  constructor() {
    super('A goods receipt line needs either a purchaseOrderLineId or an explicit productId/variantId.');
    this.name = 'MissingReceiveLineProductError';
  }
}

export type ConfirmReceiptResult = {
  goodsReceiptId: string;
  purchaseOrderNewStatus: 'PARTIALLY_RECEIVED' | 'RECEIVED' | null;
};

/**
 * `lots.unitCost` is NOT NULL at the database level — `MovementService`'s own doc comment: "a
 * lot's whole purpose is to carry a KNOWN cost basis for FEFO allocation." A receipt line with no
 * resolvable cost (no PO line to inherit from, and no explicit `unitCost` supplied — only possible
 * for 008-09's future receipt-without-PO scope) cannot create a lot at all; thrown, never a guessed
 * `0` (I7), matching `UnknownCostSurplusError`'s precedent on the same class this method calls into.
 */
export class UnknownReceiptCostError extends Error {
  constructor(public readonly productId: string) {
    super(`Goods receipt line for product '${productId}' has no resolvable unit cost — cannot create a lot without guessing a cost (I7). Supply an explicit unitCost or tie the line to a real purchase order line.`);
    this.name = 'UnknownReceiptCostError';
  }
}

/**
 * 008-07 (plan.md Phase 3, spec 05 §5.2.3): "on confirm, in one transaction: create lots → post
 * RECEIPT movements → update PO state → emit supplier performance events → outbox." 008-13 wires the
 * real supplier-performance-event emission this doc comment always named: `DELIVERY_ON_TIME`/
 * `DELIVERY_LATE` (once per receipt tied to a PO, comparing `receivedAt` against that PO's
 * `expectedDeliveryDate`), `FILL_COMPLETE`/`FILL_SHORT` (once per PO-backed line, received vs.
 * ordered quantity), and `QUALITY_REJECT` (once per line carrying a discrepancy code — confirmed
 * with the user: this codebase has no distinct "how much was rejected vs. accepted" figure yet, so
 * the line's own `receivedQuantityBaseUnits` is used as the rejected amount, the honest reading of
 * the only number that actually exists). A walk-in receipt with no `purchaseOrderId` (008-09) has no
 * "expected" delivery date or ordered quantity to compare against, so it emits no
 * delivery-timing/fill events at all — only `QUALITY_REJECT` still applies, since that only needs
 * the line's own discrepancy code, not a PO.
 *
 * A plain class taking `db`/`organizationId` directly (NOT a `TenantScopedRepository` subclass) —
 * matches `PostingService`'s exact precedent, since every real write here happens inside ONE
 * transaction this class opens itself, not through `runScoped`'s per-call transaction wrapping.
 * Deliberately NOT composed from `LotRepository.receive`/`MovementService.postMovement` as separate
 * calls — both open their own transaction internally, so calling them from an outer function would
 * silently run as multiple transactions (the exact failure I8 exists to prevent, the same lesson
 * this project has hit repeatedly: `MovementService`, `square-orders-sync.ts`, `PostingService`).
 * Writes `lots` directly inside the transaction (mirroring `PostingService`'s own precedent), and
 * calls `MovementService.postMovementInTx` — the one method deliberately made public for exactly
 * this outer-transaction composition.
 */
export class GoodsReceiptRepository {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('GoodsReceiptRepository constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  async findById(id: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const rows = await tx
          .select()
          .from(goodsReceipts)
          .where(and(eq(goodsReceipts.organizationId, this.organizationId), eq(goodsReceipts.id, id)));
        return rows[0] ?? null;
      })
    );
  }

  async findLines(goodsReceiptId: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select()
          .from(goodsReceiptLines)
          .where(and(eq(goodsReceiptLines.organizationId, this.organizationId), eq(goodsReceiptLines.goodsReceiptId, goodsReceiptId)))
          .orderBy(goodsReceiptLines.lineNumber)
      )
    );
  }

  async findLineById(goodsReceiptLineId: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const rows = await tx
          .select()
          .from(goodsReceiptLines)
          .where(and(eq(goodsReceiptLines.organizationId, this.organizationId), eq(goodsReceiptLines.id, goodsReceiptLineId)));
        return rows[0] ?? null;
      })
    );
  }

  /**
   * 008-08: appends one verified photo key to a receipt line's `photoObjectKeys` array — never
   * overwrites, since a line can carry MULTIPLE damage-claim photos uploaded one at a time (each
   * its own `requestPhotoUpload`/`confirmPhotoUpload` round trip, matching
   * `products.requestImageUpload`'s single-asset precedent, confirmed with the user over a batch
   * endpoint this codebase has no shape for yet). `COALESCE(..., '[]'::jsonb) || to_jsonb(...)` is
   * the standard Postgres JSONB-array-append idiom — a line with no photos yet starts from a real
   * empty array, never null-pointer behavior.
   */
  async appendPhotoKey(goodsReceiptLineId: string, key: string): Promise<void> {
    await this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .update(goodsReceiptLines)
          .set({ photoObjectKeys: sql`COALESCE(${goodsReceiptLines.photoObjectKeys}, '[]'::jsonb) || to_jsonb(${key}::text)` })
          .where(and(eq(goodsReceiptLines.organizationId, this.organizationId), eq(goodsReceiptLines.id, goodsReceiptLineId)))
      )
    );
  }

  /**
   * The whole receiving flow: for each line, creates a real lot + posts a real `RECEIPT` movement
   * (via `MovementService.postMovementInTx`, which also recomputes `stock_levels.avgUnitCost`),
   * writes the `goods_receipt_lines` row (including which lot it produced), accumulates each
   * `purchase_order_line`'s `receivedQuantityBaseUnits` (never overwrites — a SECOND partial
   * receipt against the same PO must add to what a FIRST receipt already recorded, not replace it —
   * the real database CHECK constraint `purchase_order_lines_received_within_ordered` is the backstop
   * against ever recording more than was ordered), then transitions the PO to `PARTIALLY_RECEIVED`
   * or `RECEIVED` depending on whether every line is now fully received. A receipt with no
   * `purchaseOrderId` (008-09's walk-in-purchase scope) still creates real lots/movements but skips
   * the PO-state step entirely — there is no PO to transition.
   *
   * `unitCost` on the INPUT is optional per line — a line tied to a real PO line inherits its
   * `unitPrice`/`conversionToBase`-derived base-unit cost when the caller doesn't supply one
   * explicitly, since the PO already recorded a real agreed price. But the RESOLVED cost is always
   * required before a lot is created: `lots.unitCost` is NOT NULL at the database level (a lot's
   * whole purpose is to carry a known cost basis for FEFO — `MovementService`'s own precedent), so a
   * line with neither a PO line to inherit from nor an explicit override throws
   * `UnknownReceiptCostError` rather than guessing `0` (I7) or writing a null the schema forbids.
   */
  async confirmReceipt(input: {
    storeId: string;
    purchaseOrderId?: string;
    supplierId: string;
    receivedAt: Date;
    receivedByUserId?: string;
    notes?: string;
    lines: readonly ReceiveLineInput[];
  }): Promise<ConfirmReceiptResult> {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () => this.confirmReceiptInTx(tx, input))
    );
  }

  private async confirmReceiptInTx(
    tx: Tx,
    input: {
      storeId: string;
      purchaseOrderId?: string;
      supplierId: string;
      receivedAt: Date;
      receivedByUserId?: string;
      notes?: string;
      lines: readonly ReceiveLineInput[];
    }
  ): Promise<ConfirmReceiptResult> {
    const goodsReceiptId = generateId();
    await tx.insert(goodsReceipts).values({
      id: goodsReceiptId,
      organizationId: this.organizationId,
      storeId: input.storeId,
      ...(input.purchaseOrderId !== undefined ? { purchaseOrderId: input.purchaseOrderId } : {}),
      supplierId: input.supplierId,
      receivedAt: input.receivedAt,
      ...(input.receivedByUserId !== undefined ? { receivedByUserId: input.receivedByUserId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });

    const movementService = new MovementService(tx as unknown as Db, this.organizationId);

    // Fetched once per receipt, not per line — `expectedDeliveryDate` is a PO-header field, and a
    // walk-in receipt (no `purchaseOrderId`) has none, so DELIVERY_ON_TIME/LATE simply never fires
    // for that case (no "expected" to compare against exists at all, I7).
    const expectedDeliveryDate =
      input.purchaseOrderId !== undefined
        ? (
            await tx
              .select({ expectedDeliveryDate: purchaseOrders.expectedDeliveryDate })
              .from(purchaseOrders)
              .where(and(eq(purchaseOrders.organizationId, this.organizationId), eq(purchaseOrders.id, input.purchaseOrderId)))
          )[0]?.expectedDeliveryDate ?? null
        : null;

    // The org's real base currency — the walk-in-receipt fallback below (no linked PO, no
    // per-line currency supplied) used to hardcode 'USD' regardless of organizations.baseCurrency,
    // the same real bug fixed everywhere else in this codebase's money-computing paths. A line
    // backed by a real PO still uses that PO's own currency (resolved per-line below), since a PO
    // created before an org's currency ever changed should keep the currency it was placed in.
    const [orgRow] = await tx
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, this.organizationId));
    const orgCurrency = (orgRow?.baseCurrency ?? 'USD') as CurrencyCode;

    for (const line of input.lines) {
      let unitCost = line.unitCost;
      let currency = line.currency;
      let productId = line.productId;
      let variantId = line.variantId;

      // A line tied to a real PO line resolves productId/variantId AND inherits the real agreed
      // cost (already converted to base units at PO creation, per I6 — converted once, never
      // re-derived mid-calculation) directly from that PO line, when the caller didn't supply an
      // explicit override for either.
      if (line.purchaseOrderLineId !== undefined) {
        const [poLine] = await tx
          .select({
            productId: purchaseOrderLines.productId,
            variantId: purchaseOrderLines.variantId,
            unitPrice: purchaseOrderLines.unitPrice,
            conversionToBase: purchaseOrderLines.conversionToBase,
          })
          .from(purchaseOrderLines)
          .where(and(eq(purchaseOrderLines.organizationId, this.organizationId), eq(purchaseOrderLines.id, line.purchaseOrderLineId)));
        if (poLine) {
          if (productId === undefined) productId = poLine.productId;
          if (variantId === undefined && poLine.variantId !== null) variantId = poLine.variantId;
          if (unitCost === undefined) {
            const conversion = new Decimal(poLine.conversionToBase);
            unitCost = new Decimal(poLine.unitPrice).dividedBy(conversion.isZero() ? new Decimal(1) : conversion).toFixed(4);
          }
        }
      }
      if (productId === undefined) {
        throw new MissingReceiveLineProductError();
      }
      if (variantId === undefined) {
        const [defaultVariant] = await tx
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(and(eq(productVariants.productId, productId), eq(productVariants.isDefault, true)));
        if (defaultVariant) variantId = defaultVariant.id;
      }
      if (variantId === undefined) {
        throw new MissingReceiveLineProductError();
      }
      const resolvedProductId = productId;
      const resolvedVariantId = variantId;

      if (currency === undefined) {
        const [po] = input.purchaseOrderId !== undefined
          ? await tx.select({ currency: purchaseOrders.currency }).from(purchaseOrders).where(and(eq(purchaseOrders.organizationId, this.organizationId), eq(purchaseOrders.id, input.purchaseOrderId)))
          : [];
        currency = po?.currency;
      }
      const resolvedCurrency = currency ?? orgCurrency;
      if (unitCost === undefined) {
        throw new UnknownReceiptCostError(resolvedProductId);
      }
      const resolvedUnitCost = unitCost;

      const lotId = generateId();
      await tx.insert(lots).values({
        id: lotId,
        organizationId: this.organizationId,
        storeId: input.storeId,
        productId: resolvedProductId,
        variantId: resolvedVariantId,
        ...(line.lotNumber !== undefined ? { lotNumber: line.lotNumber } : {}),
        receivedAt: input.receivedAt,
        ...(line.expiryDate !== undefined ? { expiryDate: line.expiryDate } : {}),
        initialQuantity: line.receivedQuantityBaseUnits,
        remainingQuantity: line.receivedQuantityBaseUnits,
        unitCost: resolvedUnitCost,
        currency: resolvedCurrency,
        supplierId: input.supplierId,
      });

      await movementService.postMovementInTx(tx, {
        storeId: input.storeId,
        productId: resolvedProductId,
        variantId: resolvedVariantId,
        lotId,
        movementType: 'RECEIPT',
        quantity: line.receivedQuantityBaseUnits,
        unitCost: resolvedUnitCost,
        currency: resolvedCurrency,
        occurredAt: input.receivedAt,
        sourceType: 'goods_receipt',
        sourceId: goodsReceiptId,
        ...(input.receivedByUserId !== undefined ? { actorUserId: input.receivedByUserId } : {}),
      });

      const goodsReceiptLineId = generateId();
      await tx.insert(goodsReceiptLines).values({
        id: goodsReceiptLineId,
        organizationId: this.organizationId,
        goodsReceiptId,
        ...(line.purchaseOrderLineId !== undefined ? { purchaseOrderLineId: line.purchaseOrderLineId } : {}),
        productId: resolvedProductId,
        variantId: resolvedVariantId,
        receivedQuantityBaseUnits: line.receivedQuantityBaseUnits,
        ...(line.baseUnitId !== undefined ? { baseUnitId: line.baseUnitId } : {}),
        unitCost: resolvedUnitCost,
        currency: resolvedCurrency,
        ...(line.lotNumber !== undefined ? { lotNumber: line.lotNumber } : {}),
        ...(line.expiryDate !== undefined ? { expiryDate: line.expiryDate } : {}),
        lotId,
        ...(line.discrepancyCode !== undefined ? { discrepancyCode: line.discrepancyCode } : {}),
        ...(line.discrepancyNotes !== undefined ? { discrepancyNotes: line.discrepancyNotes } : {}),
        lineNumber: line.lineNumber,
      });

      // Closes the deferred FK this migration added — every lot a receiving flow creates now
      // records exactly which receipt line produced it (spec 07 §7.4: "every RECEIPT movement
      // creates one of these").
      await tx.update(lots).set({ goodsReceiptLineId }).where(eq(lots.id, lotId));

      if (line.purchaseOrderLineId !== undefined) {
        await tx
          .update(purchaseOrderLines)
          .set({ receivedQuantityBaseUnits: sql`COALESCE(${purchaseOrderLines.receivedQuantityBaseUnits}, 0) + ${line.receivedQuantityBaseUnits}::numeric(19,6)` })
          .where(and(eq(purchaseOrderLines.organizationId, this.organizationId), eq(purchaseOrderLines.id, line.purchaseOrderLineId)));

        // FILL_COMPLETE/FILL_SHORT: THIS receipt's own line quantity against what THIS PO line
        // ordered — never the PO line's cumulative received-so-far, since fill rate measures how
        // complete a single delivery event was, not the PO's overall completion (a later receipt
        // finishing off a first short delivery is its own, separate fill event).
        const [orderedLine] = await tx
          .select({ quantityBaseUnits: purchaseOrderLines.quantityBaseUnits })
          .from(purchaseOrderLines)
          .where(and(eq(purchaseOrderLines.organizationId, this.organizationId), eq(purchaseOrderLines.id, line.purchaseOrderLineId)));
        if (orderedLine) {
          const ordered = new Decimal(orderedLine.quantityBaseUnits);
          const received = new Decimal(line.receivedQuantityBaseUnits);
          await SupplierPerformanceEventRepository.recordInTx(tx, this.organizationId, {
            organizationId: this.organizationId,
            supplierId: input.supplierId,
            eventType: received.greaterThanOrEqualTo(ordered) ? 'FILL_COMPLETE' : 'FILL_SHORT',
            ...(input.purchaseOrderId !== undefined ? { purchaseOrderId: input.purchaseOrderId } : {}),
            goodsReceiptId,
            productId: resolvedProductId,
            expectedValue: ordered.toFixed(6),
            actualValue: received.toFixed(6),
            variance: received.minus(ordered).toFixed(6),
            occurredAt: input.receivedAt,
          });
        }
      }

      // QUALITY_REJECT (confirmed with the user): a discrepancy-coded line's own received quantity
      // is used as the rejected amount — the only real number this codebase has for "how much of
      // this delivery was a problem," not a fabricated partial split between accepted/rejected.
      if (line.discrepancyCode !== undefined) {
        await SupplierPerformanceEventRepository.recordInTx(tx, this.organizationId, {
          organizationId: this.organizationId,
          supplierId: input.supplierId,
          eventType: 'QUALITY_REJECT',
          ...(input.purchaseOrderId !== undefined ? { purchaseOrderId: input.purchaseOrderId } : {}),
          goodsReceiptId,
          productId: resolvedProductId,
          actualValue: new Decimal(line.receivedQuantityBaseUnits).toFixed(6),
          occurredAt: input.receivedAt,
        });
      }
    }

    if (input.purchaseOrderId !== undefined && expectedDeliveryDate !== null) {
      // DELIVERY_ON_TIME/LATE: once per receipt (not per line) — the delivery either arrived by the
      // PO's expected date or it didn't, a single fact about this receiving event as a whole.
      const onTime = input.receivedAt.getTime() <= expectedDeliveryDate.getTime();
      const varianceDays = (input.receivedAt.getTime() - expectedDeliveryDate.getTime()) / (24 * 60 * 60 * 1000);
      await SupplierPerformanceEventRepository.recordInTx(tx, this.organizationId, {
        organizationId: this.organizationId,
        supplierId: input.supplierId,
        eventType: onTime ? 'DELIVERY_ON_TIME' : 'DELIVERY_LATE',
        purchaseOrderId: input.purchaseOrderId,
        goodsReceiptId,
        variance: varianceDays.toFixed(6),
        occurredAt: input.receivedAt,
      });
    }

    await tx.insert(outboxEvents).values({
      id: generateId(),
      organizationId: this.organizationId,
      aggregateType: 'goods_receipt',
      aggregateId: goodsReceiptId,
      eventType: 'receipt.recorded',
      payload: { goodsReceiptId, purchaseOrderId: input.purchaseOrderId ?? null, lineCount: input.lines.length },
    });

    if (input.purchaseOrderId === undefined) {
      return { goodsReceiptId, purchaseOrderNewStatus: null };
    }

    const newStatus = await this.transitionPurchaseOrderAfterReceiptInTx(tx, input.purchaseOrderId, input.receivedByUserId);
    return { goodsReceiptId, purchaseOrderNewStatus: newStatus };
  }

  /**
   * Determines `RECEIVE_PARTIAL` vs `RECEIVE_FULL` by comparing every real PO line's
   * `quantityBaseUnits` (ordered) against its now-updated `receivedQuantityBaseUnits` (received so
   * far, across every receipt against this PO, not just this one) — never guessed from this
   * receipt's own line count alone, since a second receipt completing a prior partial must correctly
   * reach `RECEIVED`, not `PARTIALLY_RECEIVED` again.
   */
  private async transitionPurchaseOrderAfterReceiptInTx(
    tx: Tx,
    purchaseOrderId: string,
    actorUserId: string | undefined
  ): Promise<'PARTIALLY_RECEIVED' | 'RECEIVED'> {
    const lines = await tx
      .select({ quantityBaseUnits: purchaseOrderLines.quantityBaseUnits, receivedQuantityBaseUnits: purchaseOrderLines.receivedQuantityBaseUnits })
      .from(purchaseOrderLines)
      .where(and(eq(purchaseOrderLines.organizationId, this.organizationId), eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)));

    const allFullyReceived = lines.every((line) => {
      const received = line.receivedQuantityBaseUnits !== null ? new Decimal(line.receivedQuantityBaseUnits) : new Decimal(0);
      return received.greaterThanOrEqualTo(new Decimal(line.quantityBaseUnits));
    });

    const [po] = await tx
      .select({ status: purchaseOrders.status, version: purchaseOrders.version })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.organizationId, this.organizationId), eq(purchaseOrders.id, purchaseOrderId)));
    if (!po) {
      throw new Error(`confirmReceipt: purchase order '${purchaseOrderId}' not found while transitioning after receipt.`);
    }

    // The domain state machine is the single source of truth for which transitions are legal —
    // matches `PurchaseOrderRepository.applyTransition`'s own discipline exactly, never a bare
    // status write here. A receipt against a PO not in SENT/PARTIALLY_RECEIVED (e.g. already
    // RECEIVED, or CANCELLED) is a genuine caller error surfaced as a real thrown error, not
    // silently absorbed — receiving must never appear to succeed against an invalid PO state.
    const event = allFullyReceived ? 'RECEIVE_FULL' : 'RECEIVE_PARTIAL';
    const transition = applyPurchaseOrderTransition(po.status as PurchaseOrderStatus, event);
    if (!transition.allowed) {
      throw new Error(`confirmReceipt: ${transition.reason}`);
    }
    const nextStatus = transition.nextStatus as 'PARTIALLY_RECEIVED' | 'RECEIVED';

    await tx
      .update(purchaseOrders)
      .set({ status: nextStatus, version: sql`${purchaseOrders.version} + 1`, updatedAt: new Date() })
      .where(and(eq(purchaseOrders.organizationId, this.organizationId), eq(purchaseOrders.id, purchaseOrderId)));

    await tx.insert(outboxEvents).values({
      id: generateId(),
      organizationId: this.organizationId,
      aggregateType: 'purchase_order',
      aggregateId: purchaseOrderId,
      eventType: nextStatus === 'RECEIVED' ? 'po.received' : 'po.partially_received',
      payload: { purchaseOrderId, previousStatus: po.status, newStatus: nextStatus, ...(actorUserId !== undefined ? { actorUserId } : {}) },
    });

    return nextStatus;
  }

  /**
   * `emergency_purchase_rate`'s real input (spec 12 §F) — every receipt for one store in a period,
   * with whether it had a real linked PO. `purchaseOrderId IS NULL` is the exact, schema-native
   * "walk-in/emergency purchase" signal 008-09 already established — no separate flag or inference
   * needed. `receivedAt` (not `createdAt`) is the period anchor, matching the receipt's own real
   * business-time column.
   */
  async findReceiptPoLinkage(storeId: string, from: Date, to: Date) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select({ purchaseOrderId: goodsReceipts.purchaseOrderId })
          .from(goodsReceipts)
          .where(
            and(
              eq(goodsReceipts.organizationId, this.organizationId),
              eq(goodsReceipts.storeId, storeId),
              gte(goodsReceipts.receivedAt, from),
              lt(goodsReceipts.receivedAt, to)
            )
          )
      )
    );
  }

  /**
   * `lead_time_actual`/`lead_time_variance`'s real input (spec 12 §G) — `sentAt`/`receivedAt`
   * pairs for every receipt against a real PO for one supplier in a period. Only receipts with a
   * real linked PO whose `sentAt` is set are included (I7 — a walk-in/emergency receipt with no PO
   * at all has no "lead time" to report; neither does a receipt against a PO that was never
   * actually sent, an edge case the schema technically allows but which has no real meaning here).
   */
  async findSupplierLeadTimes(supplierId: string, from: Date, to: Date) {
    const rows = await this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select({ sentAt: purchaseOrders.sentAt, receivedAt: goodsReceipts.receivedAt })
          .from(goodsReceipts)
          .innerJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.purchaseOrderId))
          .where(
            and(
              eq(goodsReceipts.organizationId, this.organizationId),
              eq(purchaseOrders.organizationId, this.organizationId),
              eq(goodsReceipts.supplierId, supplierId),
              isNotNull(purchaseOrders.sentAt),
              gte(goodsReceipts.receivedAt, from),
              lt(goodsReceipts.receivedAt, to)
            )
          )
      )
    );
    return rows
      .filter((row): row is { sentAt: Date; receivedAt: Date } => row.sentAt !== null)
      .map((row) => ({ sentAt: row.sentAt, receivedAt: row.receivedAt }));
  }
}
