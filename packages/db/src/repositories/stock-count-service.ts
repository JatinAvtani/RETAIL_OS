import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { productVariants, products, stockCountLines, stockCounts, stockLevels, units } from '../schema/index';
import { withTenantContext } from '../tenant-context';
import { generateId, type CurrencyCode, type Unit } from '@retailos/domain';
import { MovementService, UnknownCostSurplusError } from './movement-service';

export class EmptyCountScopeError extends Error {
  constructor(scope: string) {
    super(`No products match the requested count scope ('${scope}') for this store — refusing to create an empty count.`);
    this.name = 'EmptyCountScopeError';
  }
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** A variance whose magnitude is at least this fraction of the T0 theoretical quantity requires a reason code before approval (spec 05 §5.1.4's "large variances require a reason code" — the 10% figure confirmed with the user; the spec itself names no number). */
const LARGE_VARIANCE_THRESHOLD = 0.1;

export class InvalidStockCountTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition a stock count from '${from}' to '${to}'.`);
    this.name = 'InvalidStockCountTransitionError';
  }
}

export class MissingVarianceReasonError extends Error {
  constructor(public readonly lineId: string) {
    super(`Stock count line '${lineId}' has a variance exceeding the large-variance threshold and requires a reason code before approval.`);
    this.name = 'MissingVarianceReasonError';
  }
}

/**
 * 005-11 (spec 05 §5.1.4): the stocktake workflow, `DRAFT → IN_PROGRESS → SUBMITTED → APPROVED |
 * REJECTED`. Built as ONE transactional service (mirroring `MovementService`'s own reasoning,
 * 005-06) rather than a plain repository, since `startCount`/`submitCount`/`approveCount` each need
 * multi-table atomic writes (the count row, its lines, and — for approval — real `stock_movements`/
 * `stock_levels`/`lots` writes via `MovementService`).
 *
 * **The T0 snapshot is the entire reason this feature exists** (plan.md's own words: "sales
 * continue during a count... comparing a count taken at 9am against a theoretical balance read at
 * 11am produces phantom variance"). `startCount` (the `DRAFT → IN_PROGRESS` transition) is the
 * ONLY place `theoreticalQuantityT0`/`t0UnitCost` are ever written — frozen once, from
 * `stock_levels` at that exact moment, and never recomputed even if the projection changes before
 * approval. Any stock movement after `t0At` is real, correct activity — deliberately excluded from
 * variance, not folded in as apparent shrinkage.
 *
 * Approval reconciles lots FEFO-style, confirmed with the user rather than guessed: a shortfall
 * (`counted < theoretical`) draws down existing ACTIVE lots via `MovementService.consumeFefo`'s
 * exact mechanism at each lot's real cost; a surplus (`counted > theoretical`) has no originating
 * lot to draw from, so a NEW adjustment lot is created at the line's frozen `t0UnitCost` (the best
 * available cost basis — a "found" surplus has no purchase price of its own) via `LotRepository`'s
 * own `receive`-shaped insert, then a `COUNT_ADJUSTMENT` movement posted against it.
 */
export class StockCountService {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('StockCountService constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  /** Creates a DRAFT count with one line per given product/variant, no theoretical snapshot yet (I7 — a line exists once scope is defined, but hasn't been snapshotted or counted). */
  async createCount(input: {
    storeId: string;
    scope: string;
    productVariantPairs: { productId: string; variantId: string }[];
    createdByUserId?: string;
  }) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const countId = generateId();
        const countRows = await tx
          .insert(stockCounts)
          .values({
            id: countId,
            organizationId: this.organizationId,
            storeId: input.storeId,
            status: 'DRAFT',
            scope: input.scope,
            ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
          })
          .returning();
        const count = countRows[0];
        if (!count) throw new Error('Stock count insert returned no row.');

        for (const pair of input.productVariantPairs) {
          await tx.insert(stockCountLines).values({
            id: generateId(),
            organizationId: this.organizationId,
            stockCountId: countId,
            productId: pair.productId,
            variantId: pair.variantId,
          });
        }

        return count;
      })
    );
  }

  /**
   * 005-12 (spec 05 §5.1.4's own count-creation step names "full | by category | by storage
   * location" as the SAME workflow, not a separate mechanism — confirmed with the user rather than
   * assumed): resolves every non-deleted product in this category, at this store, into
   * `productVariantPairs`, then delegates to `createCount` unchanged. "Full counts are impractical
   * weekly" (spec 06's own reasoning for this feature) is exactly why a manager needs a scoped
   * subset rather than re-running the entire state machine from scratch — the state machine,
   * T0 snapshot, variance, and approval logic are identical either way.
   *
   * A product's default variant is used — matching every other place in this codebase
   * (`SaleConsumptionService`, etc.) that resolves "the" variant for a product without an explicit
   * variant selection.
   */
  async createCountByCategory(input: { storeId: string; categoryId: string; createdByUserId?: string }) {
    const pairs = await this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const rows = await tx
          .select({ productId: products.id, variantId: productVariants.id })
          .from(products)
          .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isDefault, true)))
          .where(and(eq(products.organizationId, this.organizationId), eq(products.categoryId, input.categoryId), isNull(products.deletedAt)));
        return rows;
      })
    );

    if (pairs.length === 0) {
      throw new EmptyCountScopeError(`category:${input.categoryId}`);
    }

    return this.createCount({
      storeId: input.storeId,
      scope: `category:${input.categoryId}`,
      productVariantPairs: pairs,
      ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
    });
  }

  /** Same reasoning as `createCountByCategory`, scoped by `storageLocationId` instead — spec 05 §5.1.4's other named scope. */
  async createCountByStorageLocation(input: { storeId: string; storageLocationId: string; createdByUserId?: string }) {
    const pairs = await this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const rows = await tx
          .select({ productId: products.id, variantId: productVariants.id })
          .from(products)
          .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isDefault, true)))
          .where(
            and(
              eq(products.organizationId, this.organizationId),
              eq(products.storageLocationId, input.storageLocationId),
              isNull(products.deletedAt)
            )
          );
        return rows;
      })
    );

    if (pairs.length === 0) {
      throw new EmptyCountScopeError(`storageLocation:${input.storageLocationId}`);
    }

    return this.createCount({
      storeId: input.storeId,
      scope: `storageLocation:${input.storageLocationId}`,
      productVariantPairs: pairs,
      ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
    });
  }

  /** DRAFT → IN_PROGRESS: freezes theoretical_quantity_t0/t0_unit_cost/currency for every line from the CURRENT stock_levels projection, and records t0_at. This is the one moment that matters most in this whole feature. */
  async startCount(stockCountId: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const countRows = await tx
          .select()
          .from(stockCounts)
          .where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.organizationId, this.organizationId)));
        const count = countRows[0];
        if (!count) throw new Error(`Stock count '${stockCountId}' not found.`);
        if (count.status !== 'DRAFT') {
          throw new InvalidStockCountTransitionError(count.status, 'IN_PROGRESS');
        }

        const t0At = new Date();
        const lineRows = await tx
          .select()
          .from(stockCountLines)
          .where(eq(stockCountLines.stockCountId, stockCountId));

        for (const line of lineRows) {
          const levelRows = await tx
            .select()
            .from(stockLevels)
            .where(
              and(
                eq(stockLevels.storeId, count.storeId),
                eq(stockLevels.productId, line.productId),
                eq(stockLevels.variantId, line.variantId)
              )
            );
          const level = levelRows[0];
          // No stock_levels row at all means the projection has never seen a movement for this
          // product/variant/store — a real, known zero (I7 distinguishes "never touched, so
          // legitimately zero" from "touched but cost unknown"), matching stock_levels.quantity's
          // own DEFAULT '0' convention.
          const theoreticalQuantity = level?.quantity ?? '0';
          const unitCost = level?.avgUnitCost ?? null;

          await tx
            .update(stockCountLines)
            .set({
              theoreticalQuantityT0: theoreticalQuantity,
              t0UnitCost: unitCost,
              currency: unitCost !== null ? 'USD' : null,
              updatedAt: new Date(),
            })
            .where(eq(stockCountLines.id, line.id));
        }

        const updatedRows = await tx
          .update(stockCounts)
          .set({ status: 'IN_PROGRESS', t0At, updatedAt: new Date() })
          .where(eq(stockCounts.id, stockCountId))
          .returning();
        return updatedRows[0]!;
      })
    );
  }

  /** Records a physical count for one line. Does not touch theoreticalQuantityT0/t0UnitCost — those are frozen for the life of the count, no matter how many times a line is re-entered before submission. */
  async enterCount(stockCountLineId: string, countedQuantity: string, countedByUserId?: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const rows = await tx
          .update(stockCountLines)
          .set({
            countedQuantity,
            countedAt: new Date(),
            ...(countedByUserId !== undefined ? { countedByUserId } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(stockCountLines.id, stockCountLineId), eq(stockCountLines.organizationId, this.organizationId)))
          .returning();
        if (!rows[0]) throw new Error(`Stock count line '${stockCountLineId}' not found.`);
        return rows[0];
      })
    );
  }

  /** IN_PROGRESS → SUBMITTED: computes variance = counted − theoretical_t0 (spec 05 §5.1.4's exact formula), valued at t0UnitCost, for every line. A line never counted yet blocks submission — never silently treated as a zero variance (I7). */
  async submitCount(stockCountId: string, submittedByUserId?: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const countRows = await tx
          .select()
          .from(stockCounts)
          .where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.organizationId, this.organizationId)));
        const count = countRows[0];
        if (!count) throw new Error(`Stock count '${stockCountId}' not found.`);
        if (count.status !== 'IN_PROGRESS') {
          throw new InvalidStockCountTransitionError(count.status, 'SUBMITTED');
        }

        const lineRows = await tx
          .select()
          .from(stockCountLines)
          .where(eq(stockCountLines.stockCountId, stockCountId));

        for (const line of lineRows) {
          if (line.countedQuantity === null) {
            throw new Error(`Stock count line '${line.id}' has not been counted yet — cannot submit an incomplete count.`);
          }
          const theoretical = Number(line.theoreticalQuantityT0 ?? '0');
          const counted = Number(line.countedQuantity);
          const varianceQuantity = counted - theoretical;
          const unitCost = line.t0UnitCost !== null ? Number(line.t0UnitCost) : null;
          const varianceValue = unitCost !== null ? varianceQuantity * unitCost : null;

          await tx
            .update(stockCountLines)
            .set({
              varianceQuantity: varianceQuantity.toFixed(6),
              varianceValue: varianceValue !== null ? varianceValue.toFixed(4) : null,
              updatedAt: new Date(),
            })
            .where(eq(stockCountLines.id, line.id));
        }

        const updatedRows = await tx
          .update(stockCounts)
          .set({
            status: 'SUBMITTED',
            submittedAt: new Date(),
            ...(submittedByUserId !== undefined ? { submittedByUserId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(stockCounts.id, stockCountId))
          .returning();
        return updatedRows[0]!;
      })
    );
  }

  /**
   * SUBMITTED → APPROVED: for every line with a non-zero variance, reconciles lots (a shortfall
   * draws down existing ACTIVE lots FEFO-style; a surplus creates one new adjustment lot at
   * `t0UnitCost`) and posts a `COUNT_ADJUSTMENT` movement, all in the SAME transaction as the
   * status transition. A line whose variance magnitude is at least `LARGE_VARIANCE_THRESHOLD` of
   * its theoretical quantity and has no `reasonCode` blocks approval entirely — `MissingVarianceReasonError`,
   * never a silent skip.
   *
   * `MovementService`'s own methods each open their own transaction (documented on that class) —
   * deliberately NOT called here for the lot-reconciliation writes; this method duplicates the
   * narrow subset of that logic it needs directly inside its own transaction, the same discipline
   * `MovementService` itself applies to `StockLevelRepository`/`LotRepository`.
   */
  async approveCount(stockCountId: string, approvedByUserId?: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const countRows = await tx
          .select()
          .from(stockCounts)
          .where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.organizationId, this.organizationId)));
        const count = countRows[0];
        if (!count) throw new Error(`Stock count '${stockCountId}' not found.`);
        if (count.status !== 'SUBMITTED') {
          throw new InvalidStockCountTransitionError(count.status, 'APPROVED');
        }

        const lineRows = await tx
          .select()
          .from(stockCountLines)
          .where(eq(stockCountLines.stockCountId, stockCountId));

        for (const line of lineRows) {
          const theoretical = Number(line.theoreticalQuantityT0 ?? '0');
          const varianceQuantity = Number(line.varianceQuantity ?? '0');
          if (varianceQuantity === 0) continue;

          const magnitude = theoretical !== 0 ? Math.abs(varianceQuantity) / Math.abs(theoretical) : 1;
          if (magnitude >= LARGE_VARIANCE_THRESHOLD && !line.reasonCode) {
            throw new MissingVarianceReasonError(line.id);
          }

          // A surplus (positive variance) with no known cost basis blocks approval entirely
          // (I7) — checked before any writes, not discovered mid-loop after other lines' movements
          // have already posted.
          if (varianceQuantity > 0 && line.t0UnitCost === null) {
            throw new UnknownCostSurplusError(line.productId);
          }
        }

        // Movements posted via a plain MovementService instance sharing THIS transaction's tenant
        // context would each open a SEPARATE transaction (documented on MovementService itself) —
        // instead, this reconciliation calls a dedicated method that accepts an existing Tx.
        const movementService = new MovementService(this.db, this.organizationId);
        for (const line of lineRows) {
          const varianceQuantity = Number(line.varianceQuantity ?? '0');
          if (varianceQuantity === 0) continue;

          // The product's real base unit (I6) — stock_levels/lots quantities are already stored
          // in this unit, resolved here rather than assumed.
          const productRows = await tx.select().from(products).where(eq(products.id, line.productId));
          const product = productRows[0];
          if (!product) throw new Error(`Product '${line.productId}' not found while reconciling a stock count line.`);
          const unitRows = await tx.select().from(units).where(eq(units.id, product.baseUnitId));
          const unitCode = unitRows[0]?.code;
          if (!unitCode) throw new Error(`Base unit '${product.baseUnitId}' not found for product '${line.productId}'.`);

          await movementService.reconcileCountLineInTx(tx, {
            storeId: count.storeId,
            productId: line.productId,
            variantId: line.variantId,
            unit: unitCode as Unit,
            varianceQuantity: line.varianceQuantity!,
            unitCost: line.t0UnitCost,
            currency: (line.currency ?? 'USD') as CurrencyCode,
            occurredAt: new Date(),
            sourceType: 'stocktake',
            sourceId: stockCountId,
            ...(approvedByUserId !== undefined ? { actorUserId: approvedByUserId } : {}),
          });
        }

        const updatedRows = await tx
          .update(stockCounts)
          .set({
            status: 'APPROVED',
            approvedAt: new Date(),
            ...(approvedByUserId !== undefined ? { approvedByUserId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(stockCounts.id, stockCountId))
          .returning();
        return updatedRows[0]!;
      })
    );
  }

  /** SUBMITTED → REJECTED: no movements posted, no lots touched — a rejected count is discarded, not partially applied. */
  async rejectCount(stockCountId: string, rejectedByUserId?: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const countRows = await tx
          .select()
          .from(stockCounts)
          .where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.organizationId, this.organizationId)));
        const count = countRows[0];
        if (!count) throw new Error(`Stock count '${stockCountId}' not found.`);
        if (count.status !== 'SUBMITTED') {
          throw new InvalidStockCountTransitionError(count.status, 'REJECTED');
        }

        const updatedRows = await tx
          .update(stockCounts)
          .set({
            status: 'REJECTED',
            rejectedAt: new Date(),
            ...(rejectedByUserId !== undefined ? { rejectedByUserId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(stockCounts.id, stockCountId))
          .returning();
        return updatedRows[0]!;
      })
    );
  }

  async findById(stockCountId: string) {
    const rows = await this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx.select().from(stockCounts).where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.organizationId, this.organizationId)))
      )
    );
    return rows[0] ?? null;
  }

  async findLines(stockCountId: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx.select().from(stockCountLines).where(and(eq(stockCountLines.stockCountId, stockCountId), eq(stockCountLines.organizationId, this.organizationId)))
      )
    );
  }
}
