import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { stockLevels, stockMovements } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';
import type { MovementType } from './stock-movement-repository';

/** Movement types that increase stock on hand — the only ones that ever move `avgUnitCost`. */
const INCREASING_MOVEMENT_TYPES: ReadonlySet<MovementType> = new Set([
  'RECEIPT',
  'TRANSFER_IN',
  'PRODUCTION_OUTPUT',
]);

/**
 * The projection's write/read surface for 005-03. `recordAndProject` is the movement-service
 * primitive plan.md's Phase 3 snippet describes: insert the ledger row and upsert the projection
 * in the SAME transaction, so the projection can never observe a movement the ledger doesn't also
 * have (and vice versa). Outbox emission and audit logging (also shown in that snippet) are
 * 005-06's job — this task's scope is specifically the ledger-insert + projection-upsert pair.
 *
 * `avgUnitCost` uses the standard moving-average-cost formula, recomputed ONLY on stock-increasing
 * movement types with a known `unitCost` — confirmed with the user rather than guessed, since
 * plan.md's snippet shows `quantity` being maintained but is silent on the cost formula.
 * Consumption/waste/transfer-out movements never touch `avgUnitCost`: selling or wasting stock
 * doesn't change the cost basis of what remains, and a WASTE/SALE_CONSUMPTION movement typically
 * carries the COST OF WHAT WAS TAKEN (e.g. a lot's cost), not a new purchase price — pulling the
 * running average toward that value would corrupt it. A movement with `unitCost: null` (I7 — cost
 * unknown) never touches `avgUnitCost` either, on any movement type: an unknown cost cannot inform
 * a known average, and must not silently be treated as zero.
 */
export class StockLevelRepository extends TenantScopedRepository<typeof stockLevels> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, stockLevels, organizationId);
  }

  /**
   * Inserts one `stock_movements` row and upserts the corresponding `stock_levels` row, in one
   * transaction. `quantity` is signed and already in the product's base unit (I6 — the caller has
   * already resolved units at its own boundary).
   */
  async recordAndProject(input: {
    id: string;
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
    return this.runScoped(async (db) => {
      const movementRows = await db
        .insert(stockMovements)
        .values({
          id: input.id,
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
      if (!movement) {
        throw new Error('Stock movement insert returned no row.');
      }

      const unitCost = input.unitCost ?? null;
      const recomputeCost = INCREASING_MOVEMENT_TYPES.has(input.movementType) && unitCost !== null;

      const projectionRows = await db
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
      if (!projection) {
        throw new Error('Stock level upsert returned no row.');
      }

      return { movement, projection };
    });
  }

  async find(storeId: string, productId: string, variantId: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(stockLevels)
        .where(
          scopedWhere(
            and(eq(stockLevels.storeId, storeId), eq(stockLevels.productId, productId), eq(stockLevels.variantId, variantId))
          )
        )
    );
    return rows[0] ?? null;
  }

  /** Every projection row for one store — the "what's on hand right now" overview a stock-levels page reads from directly, never summing the ledger itself (the projection exists so callers don't have to). */
  async findAllForStore(storeId: string) {
    return this.runScoped((db, scopedWhere) =>
      db.select().from(stockLevels).where(scopedWhere(eq(stockLevels.storeId, storeId)))
    );
  }
}
