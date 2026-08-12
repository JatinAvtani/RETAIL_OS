import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Decimal } from 'decimal.js';
import { generateId, applyPurchaseOrderTransition, type PurchaseOrderStatus } from '@retailos/domain';
import * as schema from '../schema/index';
import {
  goodsReceipts,
  goodsReceiptLines,
  lots,
  purchaseOrders,
  purchaseOrderLines,
  outboxEvents,
  productVariants,
  type DiscrepancyCode,
} from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';
import { MovementService } from './movement-service';

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
 * RECEIPT movements → update PO state → emit supplier performance events → outbox." Confirmed with
 * the user: supplier performance events are skipped here — `supplier_performance_events` is 008-13's
 * own table, which doesn't exist yet (the exact same situation `PostingService` (007-11) hit with
 * EPIC-008's tables during EPIC-007 — built only what already-existing tables support). 008-13 wires
 * this flow to emit real events once that table exists; not silently dropped, a real deferred scope.
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
      const resolvedCurrency = currency ?? 'USD';
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
      }
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
}
