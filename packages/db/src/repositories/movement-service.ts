import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Decimal } from 'decimal.js';
import * as schema from '../schema/index';
import { auditLogs, lots, outboxEvents, stockLevels, stockMovements, wasteReasonCodeEnum } from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';
import { generateId, allocateFefo, quantity, money, type CurrencyCode, type Lot, type Unit } from '@retailos/domain';
import type { MovementType } from './stock-movement-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * 005-10 (spec 05 SS5.1.5): a fixed, groupable set — free text here would make waste analytics
 * worthless, per the spec's own words. Enforced at the database layer too, not just this type
 * (`stock_movements_waste_reason_code`, migration 0020, scoped to WASTE rows only via a CHECK
 * constraint) — proven directly via raw psql before any of this code existed: an invalid or NULL
 * reason code on a WASTE row is genuinely rejected by Postgres, and a non-WASTE row's free-text
 * `reason_code` is genuinely unaffected.
 */
export type WasteReasonCode = (typeof wasteReasonCodeEnum)[number];

/** Movement types that increase stock on hand — the only ones that ever move `avgUnitCost`. */
const INCREASING_MOVEMENT_TYPES: ReadonlySet<MovementType> = new Set([
  'RECEIPT',
  'TRANSFER_IN',
  'PRODUCTION_OUTPUT',
]);

export class IdempotentReplayError extends Error {
  constructor(idempotencyKey: string) {
    super(`A movement with idempotency key '${idempotencyKey}' was already recorded for this organization.`);
    this.name = 'IdempotentReplayError';
  }
}

export class InsufficientStockError extends Error {
  constructor(
    public readonly shortfall: string,
    public readonly unit: string
  ) {
    super(`FEFO allocation could not fully cover the requested quantity — shortfall of ${shortfall} ${unit}.`);
    this.name = 'InsufficientStockError';
  }
}

/**
 * `lots.unit_cost` is NOT NULL at the database layer, but a stocktake surplus line's `t0UnitCost`
 * can genuinely be null (I7 — a product `stock_levels` has never priced). Confirmed with the user
 * rather than guessed: a surplus with no known cost basis blocks approval entirely — never a
 * silent `$0.00` invented cost, which would misreport the surplus as genuinely free stock.
 */
export class UnknownCostSurplusError extends Error {
  constructor(public readonly productId: string) {
    super(`A stocktake surplus for product '${productId}' has no known unit cost — cannot create an adjustment lot without guessing a cost (I7).`);
    this.name = 'UnknownCostSurplusError';
  }
}

/**
 * The movement service (005-06): the ONE place a stock movement is actually posted end to end,
 * combining what 005-01/02/03/05 each built in isolation — `stock_movements` (the ledger),
 * `stock_levels` (the projection), `lots` (FEFO draw), `allocateFefo` (the pure allocation
 * algorithm) — plus the two pieces plan.md's Phase 3 snippet always showed alongside them but no
 * prior task built: the transactional outbox (I8) and the audit log.
 *
 * Deliberately NOT built by composing `StockLevelRepository`/`LotRepository` instances: each of
 * those opens its OWN `db.transaction` internally (via `runScoped`), so calling one after another
 * from an outer function would run as two separate transactions, not one atomic unit — exactly the
 * failure mode I8 exists to prevent. Every method here opens exactly one transaction and performs
 * every write (ledger, projection, lot, outbox, audit) inside it directly, mirroring plan.md's own
 * snippet, which is one flat `BEGIN ... COMMIT` block, not a composition of smaller transactions.
 */
export class MovementService {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('MovementService constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  /**
   * Posts one movement: ledger insert, projection upsert, outbox event, audit log entry — all in
   * one transaction. Idempotent: if `idempotencyKey` is given and a movement with that key already
   * exists for this organization, throws `IdempotentReplayError` rather than silently double-
   * posting (the unique index on `(organization_id, idempotency_key)` is the real backstop; this
   * check gives a typed, catchable error instead of a raw Postgres unique-violation).
   */
  async postMovement(input: {
    storeId: string;
    productId: string;
    variantId: string;
    lotId?: string;
    movementType: MovementType;
    quantity: string;
    unitCost?: string;
    currency: string;
    occurredAt: Date;
    sourceType: string;
    sourceId?: string;
    idempotencyKey?: string;
    actorUserId?: string;
    reasonCode?: string;
    notes?: string;
  }) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () => this.postMovementInTx(tx, input))
    );
  }

  /**
   * The shared movement-posting primitive `postMovement`/`consumeFefo`/`logWaste` all use
   * internally, made PUBLIC (005-13) for the same reason `reconcileCountLineInTx` is public: a
   * caller that already owns its own transaction (`TransferService`'s initiate/receive/cancel
   * steps) needs to post a movement as part of that SAME atomic unit, not open a second
   * transaction. Every other public entry point on this class (`postMovement`, `consumeFefo`,
   * `logWaste`) opens its own transaction and calls this internally — this is the one seam where
   * an external caller can join in directly.
   */
  async postMovementInTx(
    tx: Tx,
    input: {
      id?: string;
      storeId: string;
      productId: string;
      variantId: string;
      lotId?: string;
      movementType: MovementType;
      quantity: string;
      unitCost?: string;
      currency: string;
      occurredAt: Date;
      sourceType: string;
      sourceId?: string;
      idempotencyKey?: string;
      actorUserId?: string;
      reasonCode?: string;
      notes?: string;
    }
  ) {
    if (input.idempotencyKey) {
      const existing = await tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.organizationId, this.organizationId),
            eq(stockMovements.idempotencyKey, input.idempotencyKey)
          )
        );
      if (existing.length > 0) {
        throw new IdempotentReplayError(input.idempotencyKey);
      }
    }

    const movementId = input.id ?? generateId();

    const movementRows = await tx
      .insert(stockMovements)
      .values({
        id: movementId,
        organizationId: this.organizationId,
        storeId: input.storeId,
        productId: input.productId,
        variantId: input.variantId,
        lotId: input.lotId ?? null,
        movementType: input.movementType,
        quantity: input.quantity,
        unitCost: input.unitCost ?? null,
        currency: input.currency,
        occurredAt: input.occurredAt,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        actorUserId: input.actorUserId ?? null,
        reasonCode: input.reasonCode ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    const movement = movementRows[0];
    if (!movement) throw new Error('Stock movement insert returned no row.');

    const unitCost = input.unitCost ?? null;
    const recomputeCost = INCREASING_MOVEMENT_TYPES.has(input.movementType) && unitCost !== null;

    const projectionRows = await tx
      .insert(stockLevels)
      .values({
        organizationId: this.organizationId,
        storeId: input.storeId,
        productId: input.productId,
        variantId: input.variantId,
        quantity: input.quantity,
        avgUnitCost: recomputeCost ? unitCost : null,
        lastMovementAt: input.occurredAt,
      })
      .onConflictDoUpdate({
        target: [stockLevels.storeId, stockLevels.productId, stockLevels.variantId],
        set: {
          quantity: sql`${stockLevels.quantity} + ${input.quantity}::numeric(19,6)`,
          avgUnitCost: recomputeCost
            ? sql`CASE
                    WHEN ${stockLevels.avgUnitCost} IS NULL OR ${stockLevels.quantity} <= 0
                      THEN ${unitCost}::numeric(19,4)
                    ELSE (${stockLevels.avgUnitCost} * ${stockLevels.quantity} + ${unitCost}::numeric(19,4) * ${input.quantity}::numeric(19,6))
                         / (${stockLevels.quantity} + ${input.quantity}::numeric(19,6))
                  END`
            : sql`${stockLevels.avgUnitCost}`,
          lastMovementAt: input.occurredAt,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const projection = projectionRows[0];
    if (!projection) throw new Error('Stock level upsert returned no row.');

    await tx.insert(outboxEvents).values({
      id: generateId(),
      organizationId: this.organizationId,
      aggregateType: 'stock_movement',
      aggregateId: movement.id,
      eventType: 'stock.moved',
      payload: {
        movementId: movement.id,
        storeId: input.storeId,
        productId: input.productId,
        variantId: input.variantId,
        movementType: input.movementType,
        quantity: input.quantity,
      },
    });

    await tx.insert(auditLogs).values({
      id: generateId(),
      organizationId: this.organizationId,
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'USER' : 'SYSTEM',
      action: 'stock_movement.recorded',
      entityType: 'stock_movement',
      entityId: movement.id,
      metadata: { movementType: input.movementType, sourceType: input.sourceType },
    });

    return { movement, projection };
  }

  /**
   * The FEFO consumption flow (005-05 + 005-06 wired together): allocates `requiredQuantity`
   * against a store/product's ACTIVE lots via the pure `allocateFefo` algorithm, then — for every
   * lot the allocation drew from — draws down that lot's `remainingQuantity` and posts a
   * `SALE_CONSUMPTION` movement at THAT lot's own cost, all inside one transaction. A `shortfall`
   * (the allocation couldn't fully cover the request) throws `InsufficientStockError` rather than
   * silently posting a partial consumption — the caller decides how to handle it (e.g. negative
   * stock is a signal per plan.md, but that decision belongs to 005-07's sales-ingestion flow, not
   * silently absorbed here).
   */
  async consumeFefo(input: {
    storeId: string;
    productId: string;
    variantId: string;
    requiredQuantity: string;
    unit: Unit;
    occurredAt: Date;
    sourceType: string;
    sourceId?: string;
    actorUserId?: string;
  }) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        this.allocateAndPostInTx(tx, { ...input, movementType: 'SALE_CONSUMPTION' })
      )
    );
  }

  /**
   * Waste logging (005-10, spec 05 SS5.1.5): "FEFO default, overridable." This is the FEFO-default
   * path — identical allocation mechanics to `consumeFefo` (same `allocateFefo` call, same
   * one-transaction discipline), differing only in `movementType` (`WASTE` instead of
   * `SALE_CONSUMPTION`) and the mandatory `reasonCode`. Reuses `allocateAndPostInTx` rather than
   * duplicating the allocation loop — the two flows are the same mechanism applied to a different
   * business reason, not two different mechanisms.
   */
  async logWaste(input: {
    storeId: string;
    productId: string;
    variantId: string;
    quantity: string;
    unit: Unit;
    reasonCode: WasteReasonCode;
    occurredAt: Date;
    sourceType: string;
    sourceId?: string;
    actorUserId?: string;
    notes?: string;
  }) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        this.allocateAndPostInTx(tx, {
          storeId: input.storeId,
          productId: input.productId,
          variantId: input.variantId,
          requiredQuantity: input.quantity,
          unit: input.unit,
          occurredAt: input.occurredAt,
          sourceType: input.sourceType,
          movementType: 'WASTE',
          reasonCode: input.reasonCode,
          ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
          ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        })
      )
    );
  }

  /**
   * Waste logging's override path (spec 05 SS5.1.5): staff specifies the EXACT lot wasted, rather
   * than letting FEFO pick — e.g. a specific batch is visibly spoiled while an earlier-expiring
   * lot of the same product is fine. Draws `quantity` from `lotId` directly (no `allocateFefo`
   * call at all), posts one `WASTE` movement at that lot's own cost, in one transaction. Throws if
   * `quantity` exceeds the lot's `remainingQuantity` — this is an explicit, mandatory operator
   * choice, so silently capping to what's available would misrecord what was actually thrown out.
   */
  async logWasteFromLot(input: {
    storeId: string;
    productId: string;
    variantId: string;
    lotId: string;
    quantity: string;
    reasonCode: WasteReasonCode;
    occurredAt: Date;
    sourceType: string;
    sourceId?: string;
    actorUserId?: string;
    notes?: string;
  }) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const lotRows = await tx
          .select()
          .from(lots)
          .where(and(eq(lots.id, input.lotId), eq(lots.organizationId, this.organizationId), eq(lots.status, 'ACTIVE')));
        const lotRow = lotRows[0];
        if (!lotRow) {
          throw new Error(`Cannot draw from lot '${input.lotId}' — not found, not ACTIVE, or not in this organization.`);
        }
        if (Number(input.quantity) > Number(lotRow.remainingQuantity)) {
          throw new InsufficientStockError(
            (Number(input.quantity) - Number(lotRow.remainingQuantity)).toString(),
            'lot'
          );
        }

        const drawnRows = await tx
          .update(lots)
          .set({
            remainingQuantity: sql`${lots.remainingQuantity} - ${input.quantity}`,
            status: sql`CASE WHEN ${lots.remainingQuantity} - ${input.quantity} <= 0 THEN 'DEPLETED'::lot_status ELSE ${lots.status} END`,
          })
          .where(and(eq(lots.id, input.lotId), eq(lots.organizationId, this.organizationId), eq(lots.status, 'ACTIVE')))
          .returning();
        if (!drawnRows[0]) {
          throw new Error(`Cannot draw from lot '${input.lotId}' — not found, not ACTIVE, or not in this organization.`);
        }

        const posted = await this.postMovementInTx(tx, {
          storeId: input.storeId,
          productId: input.productId,
          variantId: input.variantId,
          lotId: input.lotId,
          movementType: 'WASTE',
          quantity: `-${input.quantity}`,
          unitCost: lotRow.unitCost,
          currency: lotRow.currency,
          occurredAt: input.occurredAt,
          sourceType: input.sourceType,
          reasonCode: input.reasonCode,
          ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
          ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        });

        return { movement: posted.movement, unitCost: money(lotRow.unitCost, lotRow.currency as CurrencyCode) };
      })
    );
  }

  /**
   * The shared FEFO-allocate-then-post-per-lot loop behind both `consumeFefo` and `logWaste` —
   * extracted so the two flows can't silently drift apart on the allocation mechanics while each
   * differs only in `movementType`/`reasonCode`. `InsufficientStockError` on a shortfall, exactly
   * as `consumeFefo` always did — the caller decides how to handle it, this function never
   * silently posts a partial allocation.
   */
  private async allocateAndPostInTx(
    tx: Tx,
    input: {
      storeId: string;
      productId: string;
      variantId: string;
      requiredQuantity: string;
      unit: Unit;
      occurredAt: Date;
      sourceType: string;
      sourceId?: string;
      actorUserId?: string;
      movementType: 'SALE_CONSUMPTION' | 'WASTE' | 'COUNT_ADJUSTMENT';
      reasonCode?: WasteReasonCode;
      notes?: string;
    }
  ) {
    const candidateRows = await tx
      .select()
      .from(lots)
      .where(
        and(
          eq(lots.organizationId, this.organizationId),
          eq(lots.storeId, input.storeId),
          eq(lots.productId, input.productId),
          eq(lots.status, 'ACTIVE')
        )
      )
      .orderBy(sql`${lots.expiryDate} ASC NULLS LAST`, lots.receivedAt);

    const candidates: Lot[] = candidateRows
      .filter((row) => Number(row.remainingQuantity) > 0)
      .map((row) => ({
        lotId: row.id,
        remainingQuantity: quantity(row.remainingQuantity, input.unit),
        unitCost: money(row.unitCost, row.currency as CurrencyCode),
        expiryDate: row.expiryDate ? new Date(row.expiryDate) : null,
        receivedAt: row.receivedAt,
      }));

    const result = allocateFefo(candidates, quantity(input.requiredQuantity, input.unit));

    if (result.shortfall) {
      throw new InsufficientStockError(result.shortfall.amount.toString(), result.shortfall.unit);
    }

    const movements = [];
    for (const allocation of result.allocations) {
      const lotRow = candidateRows.find((row) => row.id === allocation.lotId);
      if (!lotRow) throw new Error(`Allocated lot '${allocation.lotId}' vanished mid-transaction.`);

      const drawnRows = await tx
        .update(lots)
        .set({
          remainingQuantity: sql`${lots.remainingQuantity} - ${allocation.quantity.amount.toString()}`,
          status: sql`CASE WHEN ${lots.remainingQuantity} - ${allocation.quantity.amount.toString()} <= 0 THEN 'DEPLETED'::lot_status ELSE ${lots.status} END`,
        })
        .where(
          and(eq(lots.id, allocation.lotId), eq(lots.organizationId, this.organizationId), eq(lots.status, 'ACTIVE'))
        )
        .returning();
      if (!drawnRows[0]) {
        throw new Error(`Cannot draw from lot '${allocation.lotId}' — not found, not ACTIVE, or not in this organization.`);
      }

      const posted = await this.postMovementInTx(tx, {
        storeId: input.storeId,
        productId: input.productId,
        variantId: input.variantId,
        lotId: allocation.lotId,
        movementType: input.movementType,
        quantity: `-${allocation.quantity.amount.toString()}`,
        unitCost: lotRow.unitCost,
        currency: lotRow.currency,
        occurredAt: input.occurredAt,
        sourceType: input.sourceType,
        ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      });
      movements.push(posted.movement);
    }

    return { movements, allocations: result.allocations, totalCost: result.totalCost };
  }

  /**
   * 006-08 (plan.md's own named "subtle part"): reverses the `SALE_CONSUMPTION` movements a
   * refunded sale posted — "the ingredients came back, or at minimum shouldn't count as sold."
   * Finds every `SALE_CONSUMPTION` row whose `sourceId` matches the ORIGINAL sale (never the
   * refund's own id — this method looks BACKWARD at what was actually consumed, it doesn't
   * recompute from the recipe, since the recipe may have changed since the sale and the reversal
   * must undo exactly what really happened), and for each one adds `fraction * |quantity|` back to
   * the EXACT lot it drew from — reviving a `DEPLETED` lot to `ACTIVE` if its `remainingQuantity`
   * goes back above zero, never creating a new lot (unlike a stocktake surplus, this stock has a
   * real, known origin lot to return to).
   *
   * `fraction` is `refundedAmount / originalTotal` (1 for a full refund, plan.md's own "partial
   * refunds reverse proportionally" acceptance criterion) — the caller (006-08's refund handler)
   * computes it from the two `sales_transactions` totals; this method only applies it.
   *
   * Posted as `SALE_REVERSAL`, a positive quantity, NOT `RETURN_TO_SUPPLIER` (a different real-world
   * event — inventory physically leaving to a vendor) and NOT `WASTE` (which means product was
   * actually discarded). Never added to `INCREASING_MOVEMENT_TYPES` — a reversal restores known-cost
   * stock to its origin lot, it isn't a new receipt at a new price, so `avgUnitCost` is intentionally
   * left unrecomputed by this movement (matching every other decreasing/restoring movement type).
   *
   * A `SALE_CONSUMPTION` row with no `lotId` (can happen if `totalCost` was `'unknown'` at
   * consumption time — I7, see `SaleConsumptionService`) is skipped, not guessed at: there is no
   * real lot to return the stock to, and inventing one would fabricate a cost basis this codebase
   * never actually observed.
   */
  async reverseSaleConsumption(
    tx: Tx,
    input: {
      originalSourceId: string;
      fraction: string;
      occurredAt: Date;
      sourceType: string;
      sourceId?: string;
      actorUserId?: string;
    }
  ) {
    const consumptionRows = await tx
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.organizationId, this.organizationId),
          eq(stockMovements.movementType, 'SALE_CONSUMPTION'),
          eq(stockMovements.sourceId, input.originalSourceId)
        )
      );

    const fraction = new Decimal(input.fraction);
    const reversals = [];

    for (const row of consumptionRows) {
      if (!row.lotId) continue; // no known lot to return stock to (I7) — nothing to reverse, not a guess

      const reverseQuantity = new Decimal(row.quantity).abs().times(fraction);
      if (reverseQuantity.isZero()) continue;

      const lotRows = await tx
        .update(lots)
        .set({
          remainingQuantity: sql`${lots.remainingQuantity} + ${reverseQuantity.toString()}`,
          status: sql`CASE WHEN ${lots.remainingQuantity} + ${reverseQuantity.toString()} > 0 THEN 'ACTIVE'::lot_status ELSE ${lots.status} END`,
        })
        .where(and(eq(lots.id, row.lotId), eq(lots.organizationId, this.organizationId)))
        .returning();
      const lotRow = lotRows[0];
      if (!lotRow) continue; // the lot itself no longer exists — nothing left to return stock to

      const posted = await this.postMovementInTx(tx, {
        storeId: row.storeId,
        productId: row.productId,
        variantId: row.variantId,
        lotId: row.lotId,
        movementType: 'SALE_REVERSAL',
        quantity: reverseQuantity.toString(),
        currency: row.currency,
        occurredAt: input.occurredAt,
        sourceType: input.sourceType,
        ...(row.unitCost !== null ? { unitCost: row.unitCost } : {}),
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      });
      reversals.push(posted.movement);
    }

    return reversals;
  }

  /**
   * 005-11's stocktake-approval lot reconciliation, called from `StockCountService.approveCount`
   * with an EXTERNAL transaction (its own, already holding the count/line status writes) — unlike
   * every other public method on this class, which each open their own transaction. This is the
   * one deliberate exception: a stocktake approval needs the count status transition AND the
   * lot/ledger writes to commit as one atomic unit, and `StockCountService` already owns that
   * transaction, so this method must run inside it rather than opening a second one (the exact
   * failure mode I8/atomicity discipline exists to prevent, documented on this class's other
   * methods).
   *
   * A negative `varianceQuantity` (counted < theoretical, a shortfall) draws down existing ACTIVE
   * lots FEFO-style — identical mechanics to `consumeFefo`/`logWaste`'s `allocateFefo` call, valued
   * at each real lot's own cost. A positive `varianceQuantity` (counted > theoretical, a surplus)
   * has no originating lot — a "found" surplus was never purchased, so a NEW adjustment lot is
   * created at the line's frozen `t0UnitCost` (the best available cost basis; I7 — if that's also
   * unknown, the lot and movement both carry a null cost rather than guessing) before posting the
   * `COUNT_ADJUSTMENT` movement against it.
   */
  async reconcileCountLineInTx(
    tx: Tx,
    input: {
      storeId: string;
      productId: string;
      variantId: string;
      /** The product's real base unit (I6) — `stock_levels`/`lots` quantities are already stored in this unit; resolved by the caller, never assumed. */
      unit: Unit;
      varianceQuantity: string;
      unitCost: string | null;
      currency: CurrencyCode;
      occurredAt: Date;
      sourceType: string;
      sourceId?: string;
      actorUserId?: string;
    }
  ) {
    const variance = Number(input.varianceQuantity);
    if (variance === 0) return null;

    if (variance < 0) {
      // Shortfall: draw down existing lots via the exact same FEFO mechanics consumeFefo/logWaste
      // use, at each lot's own real cost — a stocktake shortfall is real stock that's gone, same
      // as a sale or waste event, just discovered by counting rather than by a transaction.
      return this.allocateAndPostInTx(tx, {
        storeId: input.storeId,
        productId: input.productId,
        variantId: input.variantId,
        requiredQuantity: (-variance).toString(),
        unit: input.unit,
        occurredAt: input.occurredAt,
        sourceType: input.sourceType,
        movementType: 'COUNT_ADJUSTMENT',
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      });
    }

    // Surplus: no existing lot to draw from — create one new adjustment lot at the frozen
    // t0UnitCost. lots.unit_cost is NOT NULL at the database layer, and a guessed cost would
    // misreport a surplus as genuinely free stock (I7) — confirmed with the user: an unknown cost
    // blocks approval entirely rather than defaulting to $0.00.
    if (input.unitCost === null) {
      throw new UnknownCostSurplusError(input.productId);
    }

    const newLotId = generateId();
    await tx.insert(lots).values({
      id: newLotId,
      organizationId: this.organizationId,
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId,
      receivedAt: input.occurredAt,
      initialQuantity: variance.toString(),
      remainingQuantity: variance.toString(),
      unitCost: input.unitCost,
      currency: input.currency,
      status: 'ACTIVE',
    });

    const posted = await this.postMovementInTx(tx, {
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId,
      lotId: newLotId,
      movementType: 'COUNT_ADJUSTMENT',
      quantity: variance.toString(),
      unitCost: input.unitCost,
      currency: input.currency,
      occurredAt: input.occurredAt,
      sourceType: input.sourceType,
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    });

    return { movements: [posted.movement], lotId: newLotId };
  }
}
