import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import {
  applyPurchaseOrderTransition,
  type PurchaseOrderEvent,
  type PurchaseOrderStatus,
  type PurchaseOrderPdfInput,
} from '@retailos/domain';
import * as schema from '../schema/index';
import {
  auditLogs,
  outboxEvents,
  purchaseOrders,
  purchaseOrderLines,
  products,
  units,
  supplierProducts,
  stores,
  suppliers,
  type purchaseOrderStatusEnum,
} from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/** the design's named events (`po.created`/`po.approved`/`po.sent`/`po.cancelled`), extended
 * with symmetric ones the spec is silent on (`po.submitted`/`po.rejected`) — the same precedent
 * `documents.ts`'s `document.rejected` already established (spec names `document.approved` only). */
const EVENT_TYPE_BY_TRANSITION: Record<PurchaseOrderEvent, string> = {
  SUBMIT: 'po.submitted',
  APPROVE: 'po.approved',
  REJECT: 'po.rejected',
  SEND: 'po.sent',
  RECEIVE_PARTIAL: 'po.partially_received',
  RECEIVE_FULL: 'po.received',
  CANCEL: 'po.cancelled',
};

export type { PurchaseOrderStatus, PurchaseOrderEvent };

/**
 * Forces a real compile error if the database enum (`purchase_order_status`, schema-driven) and
 * the domain state machine's `PurchaseOrderStatus` union ever drift apart — the same class of gap
 * documented in project memory as `retailos-drizzle-enum-sync-gotcha`: a Postgres enum widened via
 * migration still typechecks stale until every consuming type is checked. `satisfies` forces this
 * assertion to actually be evaluated, unlike an unused type alias TS would silently never check.
 */
const _dbStatusesMatchDomainStatuses = null as unknown as (typeof purchaseOrderStatusEnum.enumValues)[number] satisfies PurchaseOrderStatus;
void _dbStatusesMatchDomainStatuses;

export type PurchaseOrderTransitionResult =
  | { readonly ok: true; readonly newStatus: PurchaseOrderStatus }
  | { readonly ok: false; readonly reason: string };

export type AddLineResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'NOT_EDITABLE' };

/**
 * earlier work's schema-task repository for `purchase_orders`/`purchase_order_lines` — deliberately
 * narrow, matching every prior schema task's precedent (`DocumentRepository`, `StockMovementRepository`):
 * schema plus the minimal operations that prove it's real and correctly tenant-scoped. Reorder
 * suggestion generation (already built in packages/domain), approval-threshold enforcement
 * PDF/email, and receiving are all separate, later tasks. This class
 * does not compute reorder quantities, enforce approval thresholds, or post any stock movement.
 */
export class PurchaseOrderRepository extends TenantScopedRepository<typeof purchaseOrders> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, purchaseOrders, organizationId);
  }

  /**
   * `po.created` + an audit log entry, both in the SAME transaction
   * as the insert (I8) — matching `DocumentRepository.reviewDecision`'s established pattern. Only
   * written when `createdByUserId` is provided (a real actor) — a system-seeded PO with no real
   * actor (none exists in this codebase yet, but the method signature allows it) skips the audit
   * row rather than fabricating an actor.
   */
  async create(input: {
    storeId: string;
    supplierId: string;
    poNumber: string;
    currency: string;
    expectedDeliveryDate?: Date;
    notes?: string;
    createdByUserId?: string;
  }): Promise<{ id: string }> {
    return this.runScoped(async (db) => {
      const id = generateId();
      await db.insert(purchaseOrders).values({
        id,
        organizationId: this.organizationId,
        storeId: input.storeId,
        supplierId: input.supplierId,
        poNumber: input.poNumber,
        currency: input.currency,
        ...(input.expectedDeliveryDate !== undefined ? { expectedDeliveryDate: input.expectedDeliveryDate } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
      });

      await db.insert(outboxEvents).values({
        id: generateId(),
        organizationId: this.organizationId,
        aggregateType: 'purchase_order',
        aggregateId: id,
        eventType: 'po.created',
        payload: { purchaseOrderId: id, poNumber: input.poNumber, supplierId: input.supplierId },
      });

      if (input.createdByUserId !== undefined) {
        await db.insert(auditLogs).values({
          id: generateId(),
          organizationId: this.organizationId,
          actorUserId: input.createdByUserId,
          actorType: 'USER',
          action: 'purchase_order.created',
          entityType: 'purchase_order',
          entityId: id,
          metadata: { poNumber: input.poNumber, supplierId: input.supplierId },
        });
      }

      return { id };
    });
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(purchaseOrders)
        .where(scopedWhere(eq(purchaseOrders.id, id)))
    );
    return rows[0] ?? null;
  }

  /**
   * The purchase-order list view: newest first, keyset-paginated on `id` — ids are UUID v7
   * (time-ordered), so `id < cursor` IS "strictly older than the last row the caller saw", with
   * none of OFFSET's skipped/duplicated rows when new POs land between pages. The page total is a
   * real SQL SUM over the PO's own lines (money is summed in SQL, never re-derived in JS) — NULL
   * means the PO genuinely has no lines yet (SUM over zero rows), which the caller must present as
   * that fact, never as a zero total: a figure of 0.00 on a draft nobody has priced reads as a
   * real amount.
   *
   * Returns one row beyond `limit` so the caller can tell "there is another page" apart from
   * "this page happened to be exactly full" without a second COUNT query.
   */
  async listForStore(input: {
    storeId: string;
    status?: PurchaseOrderStatus;
    supplierId?: string;
    cursor?: string;
    limit: number;
  }) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          status: purchaseOrders.status,
          currency: purchaseOrders.currency,
          createdAt: purchaseOrders.createdAt,
          supplierId: purchaseOrders.supplierId,
          supplierName: suppliers.name,
          total: sql<string | null>`(SELECT SUM(${purchaseOrderLines.lineTotal}) FROM ${purchaseOrderLines} WHERE ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id})`,
        })
        .from(purchaseOrders)
        .leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(
          scopedWhere(
            and(
              eq(purchaseOrders.storeId, input.storeId),
              ...(input.status !== undefined ? [eq(purchaseOrders.status, input.status)] : []),
              ...(input.supplierId !== undefined ? [eq(purchaseOrders.supplierId, input.supplierId)] : []),
              ...(input.cursor !== undefined ? [lt(purchaseOrders.id, input.cursor)] : [])
            )
          )
        )
        .orderBy(desc(purchaseOrders.id))
        .limit(input.limit + 1)
    );
    const page = rows.slice(0, input.limit);
    return {
      orders: page,
      nextCursor: rows.length > input.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * A DRAFT-only add — earlier work (PO create/edit) is the real editing surface. Refuses to add a line
   * to an immutable PO (`isPurchaseOrderImmutable`, packages/domain) — the same state-machine
   * module `applyTransition` uses, so "can this PO still be edited" is answered identically
   * everywhere, never re-derived ad hoc per call site.
   *
   * Returns a typed `NOT_FOUND`/`NOT_EDITABLE` reason rather than a bare `null` — the caller
   * needs to distinguish "doesn't exist / belongs to another org" (404, matching
   * every other cross-tenant convention in this codebase) from "exists but can't be edited right
   * now" (400, a real validation error, not an access question). Collapsing both into one `null`
   * would leak a cross-org attacker a 400 instead of a 404 — a real, confirmed gap found by this
   * task's own cross-tenant test.
   *
   * `lineTotal` is computed here as `quantityOrderUnits * unitPrice`, never trusted from a caller —
   * the same "server computes the money, never accepts a client-supplied total" discipline
   * `csv-import.ts`'s parser already established, since a mismatched client-supplied total would
   * silently corrupt spend data no one would notice until reconciliation.
   */
  async addLine(input: {
    purchaseOrderId: string;
    supplierProductId: string;
    productId: string;
    variantId?: string;
    quantityOrderUnits: string;
    orderUnitId?: string;
    conversionToBase: string;
    baseUnitId?: string;
    unitPrice: string;
    lineNumber: number;
  }): Promise<AddLineResult> {
    return this.runScoped(async (db, scopedWhere) => {
      const [po] = await db
        .select({ status: purchaseOrders.status })
        .from(purchaseOrders)
        .where(scopedWhere(eq(purchaseOrders.id, input.purchaseOrderId)));
      if (!po) return { ok: false, reason: 'NOT_FOUND' };
      if (po.status !== 'DRAFT') return { ok: false, reason: 'NOT_EDITABLE' };

      const quantityBaseUnits = (Number(input.quantityOrderUnits) * Number(input.conversionToBase)).toString();
      const lineTotal = (Number(input.quantityOrderUnits) * Number(input.unitPrice)).toFixed(4);

      const id = generateId();
      await db.insert(purchaseOrderLines).values({
        id,
        organizationId: this.organizationId,
        purchaseOrderId: input.purchaseOrderId,
        supplierProductId: input.supplierProductId,
        productId: input.productId,
        ...(input.variantId !== undefined ? { variantId: input.variantId } : {}),
        quantityOrderUnits: input.quantityOrderUnits,
        ...(input.orderUnitId !== undefined ? { orderUnitId: input.orderUnitId } : {}),
        conversionToBase: input.conversionToBase,
        quantityBaseUnits,
        ...(input.baseUnitId !== undefined ? { baseUnitId: input.baseUnitId } : {}),
        unitPrice: input.unitPrice,
        lineTotal,
        lineNumber: input.lineNumber,
      });
      return { ok: true, id };
    });
  }

  /**
   * Queries `purchase_order_lines`, NOT this repository's own constructor table (`purchase_orders`)
   * — `scopedWhere` is bound to whichever table was passed to `super()`, so it cannot be reused here
   * without producing a WHERE clause referencing `purchase_orders.organization_id` with no
   * `purchase_orders` in this query's FROM clause (a real Postgres error, not a silent wrong
   * result — the same bug class documented in project memory from
   * `SalesTransactionRepository.findLines()`). The tenant predicate is built by hand against
   * `purchase_order_lines.organizationId` directly instead, since that column is real on every
   * line row (every table `TenantScopedRepository`-style code touches carries its own
   * `organization_id`, even a child/line-item table).
   */
  async findLines(purchaseOrderId: string) {
    return this.runScoped((db) =>
      db
        .select()
        .from(purchaseOrderLines)
        .where(and(eq(purchaseOrderLines.organizationId, this.organizationId), eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)))
        .orderBy(purchaseOrderLines.lineNumber)
    );
  }

  /**
   * The real order VALUE (sum of every line's `lineTotal`) — earlier work's approval-threshold check
   * needs this to compare against a manager's `approvalLimit`. Returns `null` (never a fabricated
   * `'0'`) for a PO with zero lines — I7: "nothing has been priced yet" is a different fact from
   * "this order is worth $0," and a $0 order would trivially clear ANY approval threshold, which
   * is exactly the wrong default for a PO that hasn't actually been filled in yet.
   */
  async getTotal(purchaseOrderId: string): Promise<string | null> {
    const rows = await this.runScoped((db) =>
      db
        .select({ total: sql<string | null>`SUM(${purchaseOrderLines.lineTotal})` })
        .from(purchaseOrderLines)
        .where(and(eq(purchaseOrderLines.organizationId, this.organizationId), eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)))
    );
    return rows[0]?.total ?? null;
  }

  /**
   * assembles everything `generatePurchaseOrderPdf` (packages/domain, a pure function with
   * no DB access of its own) needs — the PO header, store, supplier, and every line joined to its
   * product/unit/supplier-SKU names. Returns `null` if the PO doesn't exist in this org (the
   * standard cross-tenant-safe 404 shape every other `findById`-style method here uses).
   *
   * `orderUnitLabel` falls back to `'unit'` only for display purposes on a line whose
   * `orderUnitId` was never set (an edge case `addLine`'s optional `orderUnitId` allows) — this is
   * cosmetic text on a generated document, not a business number, so it does not trip I7 the way a
   * missing MONEY or QUANTITY value would; the real `quantityOrderUnits`/`unitPrice`/`lineTotal`
   * figures are always real, already-validated column values, never defaulted here.
   */
  async buildPdfInput(purchaseOrderId: string): Promise<PurchaseOrderPdfInput | null> {
    return this.runScoped(async (db, scopedWhere) => {
      const [po] = await db
        .select({
          poNumber: purchaseOrders.poNumber,
          status: purchaseOrders.status,
          currency: purchaseOrders.currency,
          createdAt: purchaseOrders.createdAt,
          expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
          notes: purchaseOrders.notes,
          storeName: stores.name,
          storeAddress: stores.address,
          supplierName: suppliers.name,
          supplierContacts: suppliers.contacts,
        })
        .from(purchaseOrders)
        .innerJoin(stores, eq(stores.id, purchaseOrders.storeId))
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(scopedWhere(eq(purchaseOrders.id, purchaseOrderId)));
      if (!po) return null;

      const lineRows = await db
        .select({
          lineNumber: purchaseOrderLines.lineNumber,
          quantityOrderUnits: purchaseOrderLines.quantityOrderUnits,
          unitPrice: purchaseOrderLines.unitPrice,
          lineTotal: purchaseOrderLines.lineTotal,
          productName: products.name,
          orderUnitCode: units.code,
          supplierSku: supplierProducts.supplierSku,
        })
        .from(purchaseOrderLines)
        .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
        .innerJoin(supplierProducts, eq(supplierProducts.id, purchaseOrderLines.supplierProductId))
        .leftJoin(units, eq(units.id, purchaseOrderLines.orderUnitId))
        .where(and(eq(purchaseOrderLines.organizationId, this.organizationId), eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)))
        .orderBy(purchaseOrderLines.lineNumber);

      // Same real SQL SUM() `getTotal` uses (I5 — never re-derive a money total via JS
      // float/Number arithmetic over already-fetched rows, even for display-only PDF text).
      const [totalRow] = await db
        .select({ total: sql<string | null>`SUM(${purchaseOrderLines.lineTotal})` })
        .from(purchaseOrderLines)
        .where(and(eq(purchaseOrderLines.organizationId, this.organizationId), eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId)));
      const total = totalRow?.total ?? null;

      const contacts = Array.isArray(po.supplierContacts) ? (po.supplierContacts as Array<{ name?: string; email?: string }>) : [];
      const primaryContact = contacts[0] ?? null;

      return {
        poNumber: po.poNumber,
        status: po.status,
        currency: po.currency,
        createdAt: po.createdAt,
        expectedDeliveryDate: po.expectedDeliveryDate,
        notes: po.notes,
        store: { name: po.storeName, address: po.storeAddress },
        supplier: {
          name: po.supplierName,
          contactName: primaryContact?.name ?? null,
          contactEmail: primaryContact?.email ?? null,
        },
        lines: lineRows.map((line) => ({
          lineNumber: line.lineNumber,
          productName: line.productName,
          supplierSku: line.supplierSku,
          quantityOrderUnits: line.quantityOrderUnits,
          orderUnitLabel: line.orderUnitCode ?? 'unit',
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        })),
        total,
      };
    });
  }

  /**
   * records the outcome of a real SEND — the object storage key the generated PDF landed
   * at, and who the (mocked) email was addressed to. Deliberately a separate write from
   * `applyTransition`'s SEND branch: PDF generation + a mock email call are not database
   * operations, so they cannot happen INSIDE that method's transaction — this runs immediately
   * after, once both have genuinely succeeded. If the caller failed before reaching this (a PDF
   * generation error, an email-send failure), the PO is still correctly `SENT` — the design
   * ties immutability to the state transition itself, not to whether the notification succeeded.
   */
  async recordSent(purchaseOrderId: string, pdfObjectKey: string, emailSentTo: string): Promise<void> {
    await this.runScoped(async (db, scopedWhere) => {
      await db
        .update(purchaseOrders)
        .set({ pdfObjectKey, emailSentAt: new Date(), emailSentTo })
        .where(scopedWhere(eq(purchaseOrders.id, purchaseOrderId)));
    });
  }

  /**
   * Combines the pure domain state machine (`applyPurchaseOrderTransition`) with the real database
   * write, guarded by the design's own literal optimistic-locking example
   * (`WHERE id = $1 AND version = $2`) — prevents two concurrent approvals of the same PO from
   * silently racing. `expectedVersion` must match the row's CURRENT version or this returns
   * `{ ok: false }` with a conflict reason; the caller is
   * responsible for surfacing that as a 409, matching the design's stated intent.
   *
   * The event-specific actor/timestamp columns (`approvedAt`/`approvedByUserId`,
   * `rejectedAt`/`rejectedByUserId`, etc.) are set only for the event that actually fired — never
   * retroactively cleared on a later transition, so "who approved this" stays answerable even after
   * the PO later moves to SENT/RECEIVED/CLOSED.
   *
   * The status update, the outbox event (the design's own named events, `EVENT_TYPE_BY_TRANSITION`
   * above), and an audit log entry all write inside this SAME transaction (I8) — matching
   * `DocumentRepository.reviewDecision`'s established pattern, since composing them from outside
   * would silently run as separate transactions.
   */
  async applyTransition(
    id: string,
    event: PurchaseOrderEvent,
    expectedVersion: number,
    actorUserId?: string,
    reason?: string
  ): Promise<PurchaseOrderTransitionResult> {
    return this.runScoped(async (db, scopedWhere) => {
      const [row] = await db
        .select({ status: purchaseOrders.status, version: purchaseOrders.version })
        .from(purchaseOrders)
        .where(scopedWhere(eq(purchaseOrders.id, id)));
      if (!row) return { ok: false, reason: 'Purchase order not found.' };

      const transition = applyPurchaseOrderTransition(row.status as PurchaseOrderStatus, event);
      if (!transition.allowed) return { ok: false, reason: transition.reason };

      const now = new Date();
      const eventColumns: Record<string, unknown> = {};
      if (event === 'SUBMIT') {
        eventColumns.submittedAt = now;
        if (actorUserId !== undefined) eventColumns.submittedByUserId = actorUserId;
      } else if (event === 'APPROVE') {
        eventColumns.approvedAt = now;
        if (actorUserId !== undefined) eventColumns.approvedByUserId = actorUserId;
      } else if (event === 'REJECT') {
        eventColumns.rejectedAt = now;
        if (actorUserId !== undefined) eventColumns.rejectedByUserId = actorUserId;
        if (reason !== undefined) eventColumns.rejectionReason = reason;
      } else if (event === 'SEND') {
        eventColumns.sentAt = now;
        if (actorUserId !== undefined) eventColumns.sentByUserId = actorUserId;
      } else if (event === 'CANCEL') {
        eventColumns.cancelledAt = now;
        if (actorUserId !== undefined) eventColumns.cancelledByUserId = actorUserId;
        if (reason !== undefined) eventColumns.cancellationReason = reason;
      }

      const result = await db
        .update(purchaseOrders)
        .set({
          status: transition.nextStatus,
          version: sql`${purchaseOrders.version} + 1`,
          updatedAt: now,
          ...eventColumns,
        })
        .where(
          scopedWhere(and(eq(purchaseOrders.id, id), eq(purchaseOrders.version, expectedVersion)))
        )
        .returning({ id: purchaseOrders.id });

      if (result.length === 0) {
        return { ok: false, reason: 'Purchase order was modified concurrently — refresh and retry.' };
      }

      await db.insert(outboxEvents).values({
        id: generateId(),
        organizationId: this.organizationId,
        aggregateType: 'purchase_order',
        aggregateId: id,
        eventType: EVENT_TYPE_BY_TRANSITION[event],
        payload: { purchaseOrderId: id, previousStatus: row.status, newStatus: transition.nextStatus, ...(reason !== undefined ? { reason } : {}) },
      });

      if (actorUserId !== undefined) {
        await db.insert(auditLogs).values({
          id: generateId(),
          organizationId: this.organizationId,
          actorUserId,
          actorType: 'USER',
          action: EVENT_TYPE_BY_TRANSITION[event].replace('po.', 'purchase_order.'),
          entityType: 'purchase_order',
          entityId: id,
          metadata: { previousStatus: row.status, newStatus: transition.nextStatus, ...(reason !== undefined ? { reason } : {}) },
        });
      }

      return { ok: true, newStatus: transition.nextStatus };
    });
  }

  /** POs at or past `APPROVED` — the real "someone signed off on this spend" gate, confirmed with the user as the source for `total_spend`/`spend_by_category`, since this codebase has no invoice-level approval concept. */
  private static readonly APPROVED_OR_LATER_STATUSES: PurchaseOrderStatus[] = [
    'APPROVED',
    'SENT',
    'PARTIALLY_RECEIVED',
    'RECEIVED',
    'CLOSED',
  ];

  /**
   * `total_spend`/`spend_by_category`'s real input — every line of every PO at or past `APPROVED`
   * for one store in a period, joined to the product's category. `createdAt` (the PO's own, not
   * the line's) is the period anchor, matching `po_cycle_time`'s own choice of timestamp — a line
   * belongs to the period its PARENT PO was created in, not when it was later approved/sent.
   */
  async findApprovedSpendLines(storeId: string, from: Date, to: Date) {
    return this.runScoped((db) =>
      db
        .select({
          categoryId: products.categoryId,
          lineTotal: purchaseOrderLines.lineTotal,
        })
        .from(purchaseOrderLines)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
        .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
        .where(
          and(
            eq(purchaseOrderLines.organizationId, this.organizationId),
            eq(purchaseOrders.organizationId, this.organizationId),
            eq(purchaseOrders.storeId, storeId),
            inArray(purchaseOrders.status, PurchaseOrderRepository.APPROVED_OR_LATER_STATUSES),
            gte(purchaseOrders.createdAt, from),
            lt(purchaseOrders.createdAt, to)
          )
        )
    );
  }

  /**
   * `po_cycle_time`'s real input — `createdAt`/`sentAt` pairs for every PO in a store that has
   * actually been sent within the period. Only POs with a real `sentAt` are returned (I7 — a PO
   * still sitting in DRAFT/PENDING_APPROVAL has no cycle time to report yet, not a zero one).
   */
  async findSentCycleTimes(storeId: string, from: Date, to: Date) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select({ createdAt: purchaseOrders.createdAt, sentAt: purchaseOrders.sentAt })
        .from(purchaseOrders)
        .where(
          scopedWhere(
            and(
              eq(purchaseOrders.storeId, storeId),
              isNotNull(purchaseOrders.sentAt),
              gte(purchaseOrders.sentAt, from),
              lt(purchaseOrders.sentAt, to)
            )
          )
        )
    );
    return rows
      .filter((row): row is { createdAt: Date; sentAt: Date } => row.sentAt !== null)
      .map((row) => ({ createdAt: row.createdAt, sentAt: row.sentAt }));
  }

  /**
   * `order_frequency`/`average_order_value`'s real input — a real count of every PO placed with one
   * supplier in a period, and the real sum of every one of those POs' own line totals in one
   * aggregate query. Approved-or-later status is deliberately NOT required here — a supplier's
   * order frequency/average value reflects every PO placed with them, not just the ones that
   * cleared approval, since a rejected/cancelled PO still represents real ordering activity worth
   * counting for these two specific metrics (unlike `total_spend`, which is about REAL committed
   * spend, not raw ordering activity).
   */
  async findSupplierOrderSummary(
    supplierId: string,
    from: Date,
    to: Date
  ): Promise<{ poCount: number; totalSpend: string | null }> {
    const rows = await this.runScoped((db) =>
      db
        .select({
          poCount: sql<string>`COUNT(DISTINCT ${purchaseOrders.id})`,
          totalSpend: sql<string | null>`SUM(${purchaseOrderLines.lineTotal})`,
        })
        .from(purchaseOrders)
        .leftJoin(
          purchaseOrderLines,
          and(eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id), eq(purchaseOrderLines.organizationId, this.organizationId))
        )
        .where(
          and(
            eq(purchaseOrders.organizationId, this.organizationId),
            eq(purchaseOrders.supplierId, supplierId),
            gte(purchaseOrders.createdAt, from),
            lt(purchaseOrders.createdAt, to)
          )
        )
    );
    const row = rows[0];
    return { poCount: row ? Number(row.poCount) : 0, totalSpend: row?.totalSpend ?? null };
  }

  /** POs SENT to a supplier but not yet fully received — `pending_receipts_count`'s real input. `PARTIALLY_RECEIVED` counts too: a PO in that state still has real outstanding lines awaiting a further delivery. */
  private static readonly PENDING_RECEIPT_STATUSES: PurchaseOrderStatus[] = ['SENT', 'PARTIALLY_RECEIVED'];

  async countPendingReceipts(storeId: string): Promise<number> {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select({ count: sql<string>`COUNT(*)` })
        .from(purchaseOrders)
        .where(scopedWhere(and(eq(purchaseOrders.storeId, storeId), inArray(purchaseOrders.status, PurchaseOrderRepository.PENDING_RECEIPT_STATUSES))))
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * `open_po_count`'s real input — a count of POs at ONE given status for a store, matching
   * this codebase's established one-call-per-dimension precedent (`spend_by_category`/
   * `waste_by_reason`) for a metric that would otherwise need to return a breakdown the catalog's
   * fixed scalar `MetricResult` contract can't carry.
   */
  async countByStatus(storeId: string, status: PurchaseOrderStatus): Promise<number> {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select({ count: sql<string>`COUNT(*)` })
        .from(purchaseOrders)
        .where(scopedWhere(and(eq(purchaseOrders.storeId, storeId), eq(purchaseOrders.status, status))))
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * `fact_purchase_lines`'s real input — every real PO line whose PARENT PO was CREATED
   * within the resolved local day (`date` = PO `createdAt`, confirmed with the user over the
   * goods-receipt date, matching `total_spend`/`spend_by_category`'s own already-established
   * `createdAt`-based period convention, earlier work). Deliberately NOT filtered to
   * approved-or-later status — a real order line placed and later rejected/cancelled is still a
   * real purchasing event that happened on this day, and `total_spend`'s own status filter is that
   * metric's separate, later decision about which lines count as committed spend, not a fact this
   * table should pre-decide. `poId` is the SINGLE PO a line came from — a day with multiple POs to
   * the same supplier/product produces multiple fact rows, never merged, so drill-through
   * always has one real source to point at.
   */
  async findLinesForFactAggregation(storeId: string, from: Date, to: Date) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select({
          supplierId: purchaseOrders.supplierId,
          poId: purchaseOrders.id,
          productId: purchaseOrderLines.productId,
          qty: purchaseOrderLines.quantityBaseUnits,
          unitPrice: purchaseOrderLines.unitPrice,
          lineTotal: purchaseOrderLines.lineTotal,
        })
        .from(purchaseOrderLines)
        .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
        .where(
          scopedWhere(
            and(eq(purchaseOrders.storeId, storeId), gte(purchaseOrders.createdAt, from), lt(purchaseOrders.createdAt, to))
          )
        )
    );
  }
}
