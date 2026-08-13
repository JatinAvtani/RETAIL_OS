import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { supplierPerformanceEvents, type SupplierPerformanceEventType } from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type RecordSupplierPerformanceEventInput = {
  organizationId: string;
  supplierId: string;
  eventType: SupplierPerformanceEventType;
  purchaseOrderId?: string;
  goodsReceiptId?: string;
  documentId?: string;
  productId?: string;
  expectedValue?: string;
  actualValue?: string;
  variance?: string;
  occurredAt: Date;
};

/**
 * 008-13 (spec 05 §5.3.3, plan.md Phase 5): "only measured events, no invented weights in MVP."
 *
 * `recordInTx` is the ONLY write path, deliberately — it takes an ALREADY-OPEN transaction (`Tx`)
 * rather than opening its own, matching this project's own repeated, hard-learned lesson (
 * `MovementService`, `PostingService`, `GoodsReceiptRepository`, `InvoiceMatchRepository`): a
 * repository method that opens its own `db.transaction()` cannot be composed into an outer
 * function's atomic unit. Both real callers — `GoodsReceiptRepository.confirmReceipt` (delivery
 * timing, fill rate) and `InvoiceMatchRepository.runMatch` (price variance, invoice accuracy) —
 * already open their own single transaction per plan.md's confirm-step/match-step sketch; this
 * event write must land in that SAME transaction (I8) so a receipt/match can never commit while its
 * performance event silently fails to write, or vice versa. No standalone `record()` wrapping its
 * own transaction is provided, so there is no way to call this incorrectly from outside an existing
 * transaction.
 *
 * `expectedValue`/`actualValue`/`variance` are independently optional per call site — an event type
 * with no natural numeric comparison (there isn't one among the 8 real types this task uses, but
 * the column shape is generic per plan.md's own literal schema) simply omits them, never a
 * fabricated `0` (I7).
 */
export class SupplierPerformanceEventRepository {
  static async recordInTx(tx: Tx, organizationId: string, input: RecordSupplierPerformanceEventInput): Promise<void> {
    await withTenantContext(tx, organizationId, async () => {
      await tx.insert(supplierPerformanceEvents).values({
        id: generateId(),
        organizationId,
        supplierId: input.supplierId,
        eventType: input.eventType,
        ...(input.purchaseOrderId !== undefined ? { purchaseOrderId: input.purchaseOrderId } : {}),
        ...(input.goodsReceiptId !== undefined ? { goodsReceiptId: input.goodsReceiptId } : {}),
        ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
        ...(input.productId !== undefined ? { productId: input.productId } : {}),
        ...(input.expectedValue !== undefined ? { expectedValue: input.expectedValue } : {}),
        ...(input.actualValue !== undefined ? { actualValue: input.actualValue } : {}),
        ...(input.variance !== undefined ? { variance: input.variance } : {}),
        occurredAt: input.occurredAt,
      });
    });
  }

  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('SupplierPerformanceEventRepository constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  /** The real read path for 008-13's component metrics — every event for one supplier since a given date, oldest first (metric functions in packages/metrics fold over this list; they never query the database themselves, matching `documents.accuracyTelemetry`'s own "router fetches, packages/metrics computes" split). */
  async findForSupplierSince(supplierId: string, since: Date) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select()
          .from(supplierPerformanceEvents)
          .where(
            and(
              eq(supplierPerformanceEvents.organizationId, this.organizationId),
              eq(supplierPerformanceEvents.supplierId, supplierId),
              gte(supplierPerformanceEvents.occurredAt, since)
            )
          )
          .orderBy(supplierPerformanceEvents.occurredAt)
      )
    );
  }

  /**
   * 008-15: the trend comparison's PRIOR-window read — every event strictly between `[since, until)`,
   * a bounded range rather than `findForSupplierSince`'s open-ended one. Used to compute the SAME
   * component metrics over the equal-length period immediately before the current window, so the
   * scorecard can show a real period-over-period delta rather than just a single snapshot.
   */
  async findForSupplierBetween(supplierId: string, since: Date, until: Date) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select()
          .from(supplierPerformanceEvents)
          .where(
            and(
              eq(supplierPerformanceEvents.organizationId, this.organizationId),
              eq(supplierPerformanceEvents.supplierId, supplierId),
              gte(supplierPerformanceEvents.occurredAt, since),
              lt(supplierPerformanceEvents.occurredAt, until)
            )
          )
          .orderBy(supplierPerformanceEvents.occurredAt)
      )
    );
  }

  /** Real events drilled to by the 008-15 scorecard for one product within a supplier — e.g. every PRICE_VARIANCE event for a specific SKU, not just the supplier as a whole. */
  async findForSupplierAndProductSince(supplierId: string, productId: string, since: Date) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select()
          .from(supplierPerformanceEvents)
          .where(
            and(
              eq(supplierPerformanceEvents.organizationId, this.organizationId),
              eq(supplierPerformanceEvents.supplierId, supplierId),
              eq(supplierPerformanceEvents.productId, productId),
              gte(supplierPerformanceEvents.occurredAt, since)
            )
          )
          .orderBy(supplierPerformanceEvents.occurredAt)
      )
    );
  }

  async countForSupplier(supplierId: string): Promise<number> {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const [row] = await tx
          .select({ count: sql<string>`count(*)` })
          .from(supplierPerformanceEvents)
          .where(
            and(
              eq(supplierPerformanceEvents.organizationId, this.organizationId),
              eq(supplierPerformanceEvents.supplierId, supplierId)
            )
          );
        return Number(row?.count ?? 0);
      })
    );
  }
}
