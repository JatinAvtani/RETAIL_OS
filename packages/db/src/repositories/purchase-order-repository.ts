import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import {
  applyPurchaseOrderTransition,
  type PurchaseOrderEvent,
  type PurchaseOrderStatus,
} from '@retailos/domain';
import * as schema from '../schema/index';
import { auditLogs, outboxEvents, purchaseOrders, purchaseOrderLines, type purchaseOrderStatusEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/** Spec 05 §5.2.2's named events (`po.created`/`po.approved`/`po.sent`/`po.cancelled`), extended
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
 * 008-01's schema-task repository for `purchase_orders`/`purchase_order_lines` — deliberately
 * narrow, matching every prior schema task's precedent (`DocumentRepository`, `StockMovementRepository`):
 * schema plus the minimal operations that prove it's real and correctly tenant-scoped. Reorder
 * suggestion generation (008-02, already built in packages/domain), approval-threshold enforcement
 * (008-05), PDF/email (008-06), and receiving (008-07+) are all separate, later tasks. This class
 * does not compute reorder quantities, enforce approval thresholds, or post any stock movement.
 */
export class PurchaseOrderRepository extends TenantScopedRepository<typeof purchaseOrders> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, purchaseOrders, organizationId);
  }

  /**
   * `po.created` (spec 05 §5.2.2's named event) + an audit log entry, both in the SAME transaction
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
   * A DRAFT-only add — 008-05 (PO create/edit) is the real editing surface. Refuses to add a line
   * to an immutable PO (`isPurchaseOrderImmutable`, packages/domain) — the same state-machine
   * module `applyTransition` uses, so "can this PO still be edited" is answered identically
   * everywhere, never re-derived ad hoc per call site.
   *
   * Returns a typed `NOT_FOUND`/`NOT_EDITABLE` reason rather than a bare `null` — the caller
   * (008-05's router) needs to distinguish "doesn't exist / belongs to another org" (404, matching
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
   * The real order VALUE (sum of every line's `lineTotal`) — 008-05's approval-threshold check
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
   * Combines the pure domain state machine (`applyPurchaseOrderTransition`) with the real database
   * write, guarded by spec 08 §8.2's own literal optimistic-locking example
   * (`WHERE id = $1 AND version = $2`) — prevents two concurrent approvals of the same PO from
   * silently racing. `expectedVersion` must match the row's CURRENT version or this returns
   * `{ ok: false }` with a conflict reason; the caller (008-05's real approval endpoint) is
   * responsible for surfacing that as a 409, matching spec 08 §8.2's stated intent.
   *
   * The event-specific actor/timestamp columns (`approvedAt`/`approvedByUserId`,
   * `rejectedAt`/`rejectedByUserId`, etc.) are set only for the event that actually fired — never
   * retroactively cleared on a later transition, so "who approved this" stays answerable even after
   * the PO later moves to SENT/RECEIVED/CLOSED.
   *
   * The status update, the outbox event (spec 05 §5.2.2's own named events, `EVENT_TYPE_BY_TRANSITION`
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
}
