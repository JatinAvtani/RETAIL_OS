import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { auditLogs, lots, outboxEvents, stockLevels, stockMovements } from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';
import { generateId, allocateFefo, quantity, money, type CurrencyCode, type Lot, type Unit } from '@retailos/domain';
import type { MovementType } from './stock-movement-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

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

  private async postMovementInTx(
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
      withTenantContext(tx, this.organizationId, async () => {
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
            movementType: 'SALE_CONSUMPTION',
            quantity: `-${allocation.quantity.amount.toString()}`,
            unitCost: lotRow.unitCost,
            currency: lotRow.currency,
            occurredAt: input.occurredAt,
            sourceType: input.sourceType,
            ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
            ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
          });
          movements.push(posted.movement);
        }

        return { movements, allocations: result.allocations, totalCost: result.totalCost };
      })
    );
  }
}
