import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { stockMovements, type movementTypeEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

export type MovementType = (typeof movementTypeEnum.enumValues)[number];

/**
 * The ledger's write/read surface for 005-01 (schema task). Deliberately narrow: `record` inserts
 * one movement and nothing else — no stock_levels projection maintenance, no outbox emission, no
 * idempotency-conflict handling. That's 005-03/005-04/005-06's job (the movement SERVICE), which
 * wraps a call to this repository inside a larger transaction alongside those other writes. This
 * class only proves the ledger itself is real, insert-only, and tenant-isolated.
 *
 * `stock_movements` has a real `organization_id` column, so — unlike `RecipeRepository`/
 * `SupplierPriceRepository` — this DOES extend `TenantScopedRepository` for the same
 * defense-in-depth every other direct-column tenant table gets (RLS catches what the app misses;
 * the explicit WHERE-AND catches what RLS misconfiguration misses).
 *
 * No `update`/`delete` method exists on this class, ever — I3 is enforced primarily by the
 * database (UPDATE/DELETE revoked from `retailos_app` in the migration), but the repository
 * surface itself shouldn't even offer the shape of a mutation to call.
 */
export class StockMovementRepository extends TenantScopedRepository<typeof stockMovements> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, stockMovements, organizationId);
  }

  /**
   * Inserts exactly one movement row. `quantity` is signed and already in the product's base
   * unit — conversion happens once, at the caller's boundary (I6), never inside this method.
   * `unitCost` is optional and left `undefined`/`null` rather than defaulted (I7) — a movement
   * with no known cost basis (e.g. a count adjustment before any receipt exists) must say so.
   */
  async record(input: {
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
      const rows = await db
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

      const created = rows[0];
      if (!created) {
        throw new Error('Stock movement insert returned no row.');
      }
      return created;
    });
  }

  /** All movements for one product/variant at this store, most recent first. */
  async findByStoreAndVariant(storeId: string, variantId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(stockMovements)
        .where(scopedWhere(and(eq(stockMovements.storeId, storeId), eq(stockMovements.variantId, variantId))))
        .orderBy(desc(stockMovements.occurredAt))
    );
  }
}
