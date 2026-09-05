import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { organizations, outboxEvents, productVariants, products, stockCountLines, stockCounts, stockLevels, storageLocations, units } from '../schema/index';
import { withTenantContext } from '../tenant-context';
import { generateId, LARGE_VARIANCE_THRESHOLD, type CurrencyCode, type Unit } from '@retailos/domain';
import { MovementService, UnknownCostSurplusError } from './movement-service';

export class EmptyCountScopeError extends Error {
  constructor(scope: string) {
    super(`No products match the requested count scope ('${scope}') for this store — refusing to create an empty count.`);
    this.name = 'EmptyCountScopeError';
  }
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

export class InvalidStockCountTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition a stock count from '${from}' to '${to}'.`);
    this.name = 'InvalidStockCountTransitionError';
  }
}

export class UnknownVarianceError extends Error {
  constructor(public readonly lineId: string) {
    super(`Stock count line '${lineId}' has no established variance — its theoretical quantity was never snapshotted, so the shrinkage is unknown and cannot be reconciled into the ledger.`);
    this.name = 'UnknownVarianceError';
  }
}

export class MissingVarianceReasonError extends Error {
  constructor(public readonly lineId: string) {
    super(`Stock count line '${lineId}' has a variance exceeding the large-variance threshold and requires a reason code before approval.`);
    this.name = 'MissingVarianceReasonError';
  }
}

/**
 * The stocktake workflow, `DRAFT → IN_PROGRESS → SUBMITTED → APPROVED |
 * REJECTED`. Built as ONE transactional service (mirroring `MovementService`'s own reasoning)
 * rather than a plain repository, since `startCount`/`submitCount`/`approveCount` each need
 * multi-table atomic writes (the count row, its lines, and — for approval — real `stock_movements`/
 * `stock_levels`/`lots` writes via `MovementService`).
 *
 * **The T0 snapshot is the entire reason this feature exists**: sales
 * continue during a count, so comparing a count taken at 9am against a theoretical balance read at
 * 11am produces phantom variance. `startCount` (the `DRAFT → IN_PROGRESS` transition) is the
 * ONLY place `theoreticalQuantityT0`/`t0UnitCost` are ever written — frozen once, from
 * `stock_levels` at that exact moment, and never recomputed even if the projection changes before
 * approval. Any stock movement after `t0At` is real, correct activity — deliberately excluded from
 * variance, not folded in as apparent shrinkage.
 *
 * Approval reconciles lots FEFO-style, by design rather than guessed: a shortfall
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
   * "full | by category | by storage location" are the SAME workflow, not a separate
   * mechanism: resolves every non-deleted product in this category, at this store, into
   * `productVariantPairs`, then delegates to `createCount` unchanged. Full counts are impractical
   * weekly, which is exactly why a manager needs a scoped
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

  /** Same reasoning as `createCountByCategory`, scoped by `storageLocationId` instead. */
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
        // The org's real base currency — this line used to freeze every count line's currency as
        // a hardcoded 'USD' regardless of organizations.baseCurrency, the same real bug fixed
        // everywhere else in this codebase's money-computing paths.
        const [orgRow] = await tx
          .select({ baseCurrency: organizations.baseCurrency })
          .from(organizations)
          .where(eq(organizations.id, this.organizationId));
        const currency = (orgRow?.baseCurrency ?? 'USD') as CurrencyCode;

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
              currency: unitCost !== null ? currency : null,
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

  /** Sets a line's free-text `reasonCode` — the only way `approveCount`'s large-variance check can ever be satisfied for a real count. */
  async setLineReason(stockCountLineId: string, reasonCode: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const rows = await tx
          .update(stockCountLines)
          .set({ reasonCode, updatedAt: new Date() })
          .where(and(eq(stockCountLines.id, stockCountLineId), eq(stockCountLines.organizationId, this.organizationId)))
          .returning();
        if (!rows[0]) throw new Error(`Stock count line '${stockCountLineId}' not found.`);
        return rows[0];
      })
    );
  }

  /** IN_PROGRESS → SUBMITTED: computes variance = counted − theoretical_t0, valued at t0UnitCost, for every line. A line never counted yet blocks submission — never silently treated as a zero variance (I7). */
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

        // Tracks the single line with the largest real variance MAGNITUDE across the whole count —
        // the same figure `evaluateStocktakeVariance` (packages/domain) compares against
        // `LARGE_VARIANCE_THRESHOLD` to decide whether this submission is worth alerting on. `null`
        // stays `null` unless a line actually produces a real, known magnitude (I7); ties keep the
        // first line found, since only the MAGNITUDE crossing the threshold matters, not which
        // specific line reported it first.
        let maxVarianceMagnitude: Decimal | null = null;
        let largestVarianceDollarValue: Decimal | null = null;

        for (const line of lineRows) {
          if (line.countedQuantity === null) {
            throw new Error(`Stock count line '${line.id}' has not been counted yet — cannot submit an incomplete count.`);
          }
          // Decimal, not `Number`: these are money and quantity (I5). Binary floating point cannot
          // represent most decimal fractions exactly, so `counted - theoretical` and
          // `varianceQuantity * unitCost` accumulated real representation error before being
          // written back through `toFixed` — silently wrong shrinkage values in the ledger, and
          // invisible to the invariant scanner, which cannot see a raw `Number()` coercion.
          //
          // `theoreticalQuantityT0` is a NULLABLE column, and the previous `?? '0'` turned a
          // genuinely unknown theoretical quantity into a fabricated variance measured against
          // zero — an I7 violation that reads as a real, actionable shrinkage figure. A line whose
          // theoretical quantity was never established has an unknown variance, so both variance
          // columns (also nullable) stay null rather than carrying an invented number.
          const counted = new Decimal(line.countedQuantity);
          const varianceQuantity = line.theoreticalQuantityT0 !== null ? counted.minus(new Decimal(line.theoreticalQuantityT0)) : null;
          const unitCost = line.t0UnitCost !== null ? new Decimal(line.t0UnitCost) : null;
          const varianceValue = varianceQuantity !== null && unitCost !== null ? varianceQuantity.times(unitCost) : null;

          await tx
            .update(stockCountLines)
            .set({
              varianceQuantity: varianceQuantity !== null ? varianceQuantity.toFixed(6) : null,
              varianceValue: varianceValue !== null ? varianceValue.toFixed(4) : null,
              updatedAt: new Date(),
            })
            .where(eq(stockCountLines.id, line.id));

          if (varianceQuantity !== null && line.theoreticalQuantityT0 !== null) {
            const theoretical = new Decimal(line.theoreticalQuantityT0);
            const magnitude = theoretical.isZero() ? null : varianceQuantity.abs().dividedBy(theoretical.abs());
            if (magnitude !== null && (maxVarianceMagnitude === null || magnitude.greaterThan(maxVarianceMagnitude))) {
              maxVarianceMagnitude = magnitude;
              largestVarianceDollarValue = varianceValue;
            }
          }
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
        const updated = updatedRows[0]!;

        // Same transaction as the status transition (I8) — `stocktake_variance`'s real trigger.
        // `evaluateStocktakeVariance` (packages/domain) decides downstream whether this magnitude
        // actually clears the alerting bar; this event fires unconditionally on every submission,
        // the same "the event is cheap, the evaluation decides" shape `po.submitted` already uses.
        await tx.insert(outboxEvents).values({
          id: generateId(),
          organizationId: this.organizationId,
          aggregateType: 'stock_count',
          aggregateId: stockCountId,
          eventType: 'stocktake.submitted',
          payload: {
            stockCountId,
            storeId: updated.storeId,
            maxVarianceMagnitude: maxVarianceMagnitude !== null ? maxVarianceMagnitude.toFixed(6) : null,
            largestVarianceDollarValue: largestVarianceDollarValue !== null ? largestVarianceDollarValue.toFixed(4) : null,
          },
        });

        return updated;
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
          // A NULL variance means "not established" — `submitCount` leaves it null when the line's
          // theoretical quantity was never snapshotted. The previous `?? '0'` collapsed that
          // unknown into "zero variance, nothing to reconcile" and skipped the line silently, so a
          // line with genuinely unknown shrinkage was approved as if it had been checked and found
          // clean (I7). Refuse instead: an unknown variance cannot be reconciled into the ledger.
          if (line.varianceQuantity === null) {
            throw new UnknownVarianceError(line.id);
          }
          const varianceQuantity = new Decimal(line.varianceQuantity);
          if (varianceQuantity.isZero()) continue;

          // Decimal throughout (I5) — this magnitude gates whether a reason code is required, so
          // float error here can flip a line across the threshold in either direction.
          const theoretical = line.theoreticalQuantityT0 !== null ? new Decimal(line.theoreticalQuantityT0) : null;
          const magnitude =
            theoretical !== null && !theoretical.isZero()
              ? varianceQuantity.abs().dividedBy(theoretical.abs())
              : new Decimal(1);
          if (magnitude.greaterThanOrEqualTo(LARGE_VARIANCE_THRESHOLD) && !line.reasonCode) {
            throw new MissingVarianceReasonError(line.id);
          }

          // A surplus (positive variance) with no known cost basis blocks approval entirely
          // (I7) — checked before any writes, not discovered mid-loop after other lines' movements
          // have already posted.
          if (varianceQuantity.greaterThan(0) && line.t0UnitCost === null) {
            throw new UnknownCostSurplusError(line.productId);
          }
        }

        // Movements posted via a plain MovementService instance sharing THIS transaction's tenant
        // context would each open a SEPARATE transaction (documented on MovementService itself) —
        // instead, this reconciliation calls a dedicated method that accepts an existing Tx.
        const movementService = new MovementService(this.db, this.organizationId);
        for (const line of lineRows) {
          // The pre-flight loop above already refused every null variance, so a null here would be
          // a genuine invariant break rather than ordinary missing data — surfaced, never coerced.
          if (line.varianceQuantity === null) {
            throw new UnknownVarianceError(line.id);
          }
          const varianceQuantity = new Decimal(line.varianceQuantity);
          if (varianceQuantity.isZero()) continue;

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

  /**
   * the plan Phase 7: "stocktake sheets ordered by physical storage location, not alphabetically —
   * the person counting walks the room." A product with no `storageLocationId` set sorts last
   * (nulls last), same convention as `LotRepository.findFefoCandidates`' expiry ordering — an
   * unlocated product isn't a sort error, it just can't be placed in a walking order yet.
   */
  async findLinesOrderedByStorageLocation(stockCountId: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select({
            line: stockCountLines,
            productName: products.name,
            productSku: products.sku,
            storageLocationName: storageLocations.name,
          })
          .from(stockCountLines)
          .innerJoin(products, eq(products.id, stockCountLines.productId))
          .leftJoin(storageLocations, eq(storageLocations.id, products.storageLocationId))
          .where(and(eq(stockCountLines.stockCountId, stockCountId), eq(stockCountLines.organizationId, this.organizationId)))
          .orderBy(sql`${storageLocations.name} ASC NULLS LAST`, asc(products.name))
      )
    );
  }

  /**
   * `shrinkage_value`/`shrinkage_percentage`'s real input — every line's already-
   * frozen `varianceValue`/`varianceQuantity` from APPROVED counts whose T0 snapshot (`t0At`, the
   * moment the physical count actually happened — NOT `approvedAt`, which can trail by days if
   * review is delayed) falls within `[from, to)`. Deliberately reads the count's own `t0At` for the
   * period filter rather than `approvedAt`, matching this project's bi-temporal convention
   * (`occurred_at` is business time; when a count was later rubber-stamped is not). Only `APPROVED`
   * counts are included — a `SUBMITTED`-but-not-yet-approved count's variance isn't real shrinkage
   * yet, matching `approveCount`'s own reconciliation gate (variance only posts to the ledger on
   * approval). A line with a `NULL` `varianceValue` (never actually counted, so no variance was ever
   * computed) is simply excluded, not coerced to zero (I7) — the caller decides what an incomplete
   * count means for its own metric.
   */
  async findApprovedVarianceLines(storeId: string, from: Date, to: Date) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx
          .select({
            varianceQuantity: stockCountLines.varianceQuantity,
            varianceValue: stockCountLines.varianceValue,
          })
          .from(stockCountLines)
          .innerJoin(stockCounts, eq(stockCounts.id, stockCountLines.stockCountId))
          .where(
            and(
              eq(stockCountLines.organizationId, this.organizationId),
              eq(stockCounts.organizationId, this.organizationId),
              eq(stockCounts.storeId, storeId),
              eq(stockCounts.status, 'APPROVED'),
              sql`${stockCounts.t0At} >= ${from.toISOString()}::timestamptz`,
              sql`${stockCounts.t0At} < ${to.toISOString()}::timestamptz`
            )
          )
      )
    );
  }
}
