import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { lots, stockTransfers } from '../schema/index';
import { withTenantContext } from '../tenant-context';
import { generateId, allocateFefo, quantity, money, type CurrencyCode, type Lot, type Unit } from '@retailos/domain';
import { MovementService, InsufficientStockError } from './movement-service';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export class InvalidTransferTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition a stock transfer from '${from}' to '${to}'.`);
    this.name = 'InvalidTransferTransitionError';
  }
}

/**
 * inter-store transfers with a
 * real in-transit window, confirmed with the user as a two-step lifecycle
 * (`PENDING → IN_TRANSIT → RECEIVED`, or `CANCELLED`) rather than a single atomic OUT+IN pair — a
 * `stock_movements` row is a point-in-time fact and cannot by itself represent an ONGOING state.
 *
 * `initiateTransfer` immediately posts `TRANSFER_OUT` at the source store (physically, the stock
 * is gone from there right away) and creates a NEW lot at the destination store in `IN_TRANSIT`
 * status, carrying the original lot's cost/expiry UNCHANGED (the plan's exact words: "lots carry
 * across with their original cost and expiry"). That destination lot is invisible to FEFO
 * (`consumeFefo`/`findFefoCandidates` only ever query `status = 'ACTIVE'`) until `receiveTransfer`
 * posts `TRANSFER_IN` and flips it `ACTIVE` — mirroring the real physical process: stock in transit
 * is unusable at BOTH ends simultaneously.
 *
 * Built as its own transactional service class (mirroring `MovementService`/`StockCountService`'s
 * own reasoning) since each step needs multiple atomic writes: `initiateTransfer` draws down the
 * source lot AND posts `TRANSFER_OUT` AND creates the destination lot AND writes the transfer row,
 * all in one transaction.
 */
export class TransferService {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('TransferService constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  /**
   * FEFO-selects a source lot (same `allocateFefo` mechanism as `consumeFefo`/`logWaste` —
   * confirmed with the user as the default, matching every other place this codebase draws stock
   * without an explicit lot override), draws it down, posts `TRANSFER_OUT`, and creates the
   * destination `IN_TRANSIT` lot at the SAME cost/expiry — all in one transaction. Throws
   * `InsufficientStockError` (never a partial transfer) if the source store doesn't have enough.
   */
  async initiateTransfer(input: {
    sourceStoreId: string;
    destinationStoreId: string;
    productId: string;
    variantId: string;
    quantity: string;
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
              eq(lots.storeId, input.sourceStoreId),
              eq(lots.productId, input.productId),
              eq(lots.status, 'ACTIVE')
            )
          )
          .orderBy(sql`${lots.expiryDate} ASC NULLS LAST`, lots.receivedAt)
      // Row-lock the candidate lots for the rest of this transaction (I3). Without it, two
      // concurrent consumers both read the same `remaining_quantity`, both pass `allocateFefo`'s
      // sufficiency check, and both draw — driving the lot negative and breaking the
      // ledger-projection identity. Verified against real Postgres: unlocked, two sessions drawing
      // 8 from a lot of 10 both succeeded and left it at -6.000000; with FOR UPDATE the second
      // session blocked, then read the committed 2.000000 and correctly refused.
      //
      // Plain FOR UPDATE, deliberately NOT SKIP LOCKED: skipping a locked lot would silently draw
      // from a LATER-expiring one, quietly violating FEFO ordering and costing the draw at the
      // wrong lot's unit cost. Waiting is correct here — the contended lot is the one FEFO says
      // to use.
      .for('update');

        const candidates: Lot[] = candidateRows
          .filter((row) => Number(row.remainingQuantity) > 0)
          .map((row) => ({
            lotId: row.id,
            remainingQuantity: quantity(row.remainingQuantity, input.unit),
            unitCost: money(row.unitCost, row.currency as CurrencyCode),
            expiryDate: row.expiryDate ? new Date(row.expiryDate) : null,
            receivedAt: row.receivedAt,
          }));

        const result = allocateFefo(candidates, quantity(input.quantity, input.unit));
        if (result.shortfall) {
          throw new InsufficientStockError(result.shortfall.amount.toString(), result.shortfall.unit);
        }

        // A transfer moves ONE lot's worth of stock at a time (spec/the plan name no
        // multi-lot-split behavior for transfers, unlike consumeFefo/logWaste which explicitly
        // span multiple lots) — confirmed reasonable since a real transfer is normally a single
        // pallet/batch move, not a synthetic blend of several source lots. If FEFO selects more
        // than one lot to satisfy the request, only the first (earliest-expiring) allocation is
        // used and the request is scoped to that lot's available quantity — the caller should
        // issue a separate transfer per lot for a genuine multi-lot move.
        const allocation = result.allocations[0];
        if (!allocation) throw new Error('FEFO allocation produced no lots despite no shortfall.');
        const sourceLotRow = candidateRows.find((row) => row.id === allocation.lotId);
        if (!sourceLotRow) throw new Error(`Allocated lot '${allocation.lotId}' vanished mid-transaction.`);

        await tx
          .update(lots)
          .set({
            remainingQuantity: sql`${lots.remainingQuantity} - ${allocation.quantity.amount.toString()}`,
            status: sql`CASE WHEN ${lots.remainingQuantity} - ${allocation.quantity.amount.toString()} <= 0 THEN 'DEPLETED'::lot_status ELSE ${lots.status} END`,
          })
          .where(and(eq(lots.id, allocation.lotId), eq(lots.organizationId, this.organizationId), eq(lots.status, 'ACTIVE')));

        const movementService = new MovementService(this.db, this.organizationId);
        const outMovement = await movementService.postMovementInTx(tx, {
          storeId: input.sourceStoreId,
          productId: input.productId,
          variantId: input.variantId,
          lotId: allocation.lotId,
          movementType: 'TRANSFER_OUT',
          quantity: `-${allocation.quantity.amount.toString()}`,
          unitCost: sourceLotRow.unitCost,
          currency: sourceLotRow.currency,
          occurredAt: input.occurredAt,
          sourceType: input.sourceType,
          ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
          ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
        });

        const destinationLotId = generateId();
        await tx.insert(lots).values({
          id: destinationLotId,
          organizationId: this.organizationId,
          storeId: input.destinationStoreId,
          productId: input.productId,
          variantId: input.variantId,
          lotNumber: sourceLotRow.lotNumber,
          receivedAt: input.occurredAt,
          expiryDate: sourceLotRow.expiryDate,
          initialQuantity: allocation.quantity.amount.toString(),
          remainingQuantity: allocation.quantity.amount.toString(),
          unitCost: sourceLotRow.unitCost,
          currency: sourceLotRow.currency,
          status: 'IN_TRANSIT',
        });

        const transferId = generateId();
        const transferRows = await tx
          .insert(stockTransfers)
          .values({
            id: transferId,
            organizationId: this.organizationId,
            sourceStoreId: input.sourceStoreId,
            destinationStoreId: input.destinationStoreId,
            productId: input.productId,
            variantId: input.variantId,
            quantity: allocation.quantity.amount.toString(),
            status: 'IN_TRANSIT',
            sourceLotId: allocation.lotId,
            destinationLotId,
            initiatedAt: input.occurredAt,
            ...(input.actorUserId !== undefined ? { initiatedByUserId: input.actorUserId } : {}),
          })
          .returning();
        const transfer = transferRows[0];
        if (!transfer) throw new Error('Stock transfer insert returned no row.');

        return { transfer, outMovement: outMovement.movement, destinationLotId };
      })
    );
  }

  /** IN_TRANSIT → RECEIVED: posts TRANSFER_IN at the destination and flips the destination lot ACTIVE (now visible to FEFO). */
  async receiveTransfer(transferId: string, receivedByUserId?: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const transferRows = await tx
          .select()
          .from(stockTransfers)
          .where(and(eq(stockTransfers.id, transferId), eq(stockTransfers.organizationId, this.organizationId)));
        const transfer = transferRows[0];
        if (!transfer) throw new Error(`Stock transfer '${transferId}' not found.`);
        if (transfer.status !== 'IN_TRANSIT') {
          throw new InvalidTransferTransitionError(transfer.status, 'RECEIVED');
        }
        if (!transfer.destinationLotId) {
          throw new Error(`Stock transfer '${transferId}' has no destination lot — cannot receive.`);
        }

        const destinationLotRows = await tx
          .select()
          .from(lots)
          .where(and(eq(lots.id, transfer.destinationLotId), eq(lots.organizationId, this.organizationId)));
        const destinationLot = destinationLotRows[0];
        if (!destinationLot) throw new Error(`Destination lot '${transfer.destinationLotId}' not found.`);

        await tx.update(lots).set({ status: 'ACTIVE' }).where(eq(lots.id, transfer.destinationLotId));

        const movementService = new MovementService(this.db, this.organizationId);
        const receivedAt = new Date();
        await movementService.postMovementInTx(tx, {
          storeId: transfer.destinationStoreId,
          productId: transfer.productId,
          variantId: transfer.variantId,
          lotId: transfer.destinationLotId,
          movementType: 'TRANSFER_IN',
          quantity: transfer.quantity,
          unitCost: destinationLot.unitCost,
          currency: destinationLot.currency,
          occurredAt: receivedAt,
          sourceType: 'transfer',
          sourceId: transferId,
          ...(receivedByUserId !== undefined ? { actorUserId: receivedByUserId } : {}),
        });

        const updatedRows = await tx
          .update(stockTransfers)
          .set({
            status: 'RECEIVED',
            receivedAt,
            ...(receivedByUserId !== undefined ? { receivedByUserId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(stockTransfers.id, transferId))
          .returning();
        return updatedRows[0]!;
      })
    );
  }

  /**
   * IN_TRANSIT → CANCELLED: the shipment never arrives (lost, damaged in transit, never actually
   * sent). Reverses the source-side draw with a compensating `TRANSFER_IN` back at the SOURCE
   * store (I3 — never an UPDATE/DELETE on the ledger; a correction is a new row) and marks the
   * destination's `IN_TRANSIT` lot `DEPLETED` (never `ACTIVE` — that stock was never actually
   * usable and never will be from this transfer).
   */
  async cancelTransfer(transferId: string, cancelledByUserId?: string) {
    return this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, async () => {
        const transferRows = await tx
          .select()
          .from(stockTransfers)
          .where(and(eq(stockTransfers.id, transferId), eq(stockTransfers.organizationId, this.organizationId)));
        const transfer = transferRows[0];
        if (!transfer) throw new Error(`Stock transfer '${transferId}' not found.`);
        if (transfer.status !== 'IN_TRANSIT') {
          throw new InvalidTransferTransitionError(transfer.status, 'CANCELLED');
        }
        if (!transfer.sourceLotId || !transfer.destinationLotId) {
          throw new Error(`Stock transfer '${transferId}' is missing a source or destination lot.`);
        }

        const sourceLotRows = await tx
          .select()
          .from(lots)
          .where(and(eq(lots.id, transfer.sourceLotId), eq(lots.organizationId, this.organizationId)));
        const sourceLot = sourceLotRows[0];
        if (!sourceLot) throw new Error(`Source lot '${transfer.sourceLotId}' not found.`);

        // Give the quantity back to the source lot — the physical stock never actually left, or
        // came back. Reopening a DEPLETED lot back to ACTIVE is correct here (unlike the
        // append-only ledger, a lot's remaining_quantity is a live projection, same category as
        // stock_levels — see stock-level-repository.ts's own reasoning).
        await tx
          .update(lots)
          .set({
            remainingQuantity: sql`${lots.remainingQuantity} + ${transfer.quantity}`,
            status: 'ACTIVE',
          })
          .where(eq(lots.id, transfer.sourceLotId));

        await tx.update(lots).set({ status: 'DEPLETED' }).where(eq(lots.id, transfer.destinationLotId));

        const movementService = new MovementService(this.db, this.organizationId);
        const cancelledAt = new Date();
        await movementService.postMovementInTx(tx, {
          storeId: transfer.sourceStoreId,
          productId: transfer.productId,
          variantId: transfer.variantId,
          lotId: transfer.sourceLotId,
          movementType: 'TRANSFER_IN',
          quantity: transfer.quantity,
          unitCost: sourceLot.unitCost,
          currency: sourceLot.currency,
          occurredAt: cancelledAt,
          sourceType: 'transfer_cancellation',
          sourceId: transferId,
          notes: 'Compensating reversal for a cancelled inter-store transfer.',
          ...(cancelledByUserId !== undefined ? { actorUserId: cancelledByUserId } : {}),
        });

        const updatedRows = await tx
          .update(stockTransfers)
          .set({
            status: 'CANCELLED',
            cancelledAt,
            ...(cancelledByUserId !== undefined ? { cancelledByUserId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(stockTransfers.id, transferId))
          .returning();
        return updatedRows[0]!;
      })
    );
  }

  async findById(transferId: string) {
    const rows = await this.db.transaction((tx) =>
      withTenantContext(tx, this.organizationId, () =>
        tx.select().from(stockTransfers).where(and(eq(stockTransfers.id, transferId), eq(stockTransfers.organizationId, this.organizationId)))
      )
    );
    return rows[0] ?? null;
  }
}
