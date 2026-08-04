import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { lots } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * The 005-02 scope: schema + a minimal repository proving the FEFO ordering and the
 * remaining-quantity guard are real. The FEFO allocation ALGORITHM (choosing how much to draw
 * from which lot for a given required quantity) is pure domain logic in `packages/domain`
 * (005-05) — this class only surfaces lots in the correct order and lets a caller record what was
 * drawn. The movement-service integration (posting a SALE_CONSUMPTION/WASTE movement and updating
 * `remaining_quantity` in the same transaction as the ledger insert) is 005-06's job.
 */
export class LotRepository extends TenantScopedRepository<typeof lots> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, lots, organizationId);
  }

  /**
   * Receiving a new batch. `remainingQuantity` always starts equal to `initialQuantity` — a lot
   * is never created partially consumed. `unitCost` is required (not optional, unlike
   * `stock_movements.unitCost`) because a lot's whole purpose is to carry a KNOWN cost basis for
   * FEFO allocation (I7 has nothing to degrade to here — a lot with unknown cost cannot answer
   * "what did the units consumed from it actually cost").
   */
  async receive(input: {
    id: string;
    storeId: string;
    productId: string;
    variantId: string;
    lotNumber?: string;
    receivedAt: Date;
    expiryDate?: string;
    initialQuantity: string;
    unitCost: string;
    currency: string;
    supplierId?: string;
    goodsReceiptLineId?: string;
    sourceDocumentId?: string;
  }) {
    return this.runScoped(async (db) => {
      const rows = await db
        .insert(lots)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          storeId: input.storeId,
          productId: input.productId,
          variantId: input.variantId,
          lotNumber: input.lotNumber ?? null,
          receivedAt: input.receivedAt,
          expiryDate: input.expiryDate ?? null,
          initialQuantity: input.initialQuantity,
          remainingQuantity: input.initialQuantity,
          unitCost: input.unitCost,
          currency: input.currency,
          supplierId: input.supplierId ?? null,
          goodsReceiptLineId: input.goodsReceiptLineId ?? null,
          sourceDocumentId: input.sourceDocumentId ?? null,
        })
        .returning();

      const created = rows[0];
      if (!created) {
        throw new Error('Lot insert returned no row.');
      }
      return created;
    });
  }

  /**
   * FEFO candidates for one store/product: ACTIVE lots with stock remaining, earliest expiry
   * first — nulls (no expiry date) last, since an item with no tracked expiry should be drawn
   * from only after every dated lot is exhausted. Ties broken by `receivedAt` (earliest first),
   * matching plan.md's "sort by expiry (nulls last) then received_at". This method only orders
   * candidates; it does not decide how much to take from each — that's `allocateFefo`
   * (`packages/domain`, 005-05).
   */
  async findFefoCandidates(storeId: string, productId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(lots)
        .where(
          scopedWhere(
            and(eq(lots.storeId, storeId), eq(lots.productId, productId), eq(lots.status, 'ACTIVE'), gt(lots.remainingQuantity, '0'))
          )
        )
        .orderBy(sql`${lots.expiryDate} ASC NULLS LAST`, asc(lots.receivedAt))
    );
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db.select().from(lots).where(scopedWhere(eq(lots.id, id)))
    );
    return rows[0] ?? null;
  }

  /** Every lot for one product at this store, regardless of status — the lot-detail drill-down's listing, unlike `findFefoCandidates` which deliberately only surfaces ACTIVE, in-stock lots for allocation. */
  async findAllForProduct(storeId: string, productId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(lots)
        .where(scopedWhere(and(eq(lots.storeId, storeId), eq(lots.productId, productId))))
        .orderBy(sql`${lots.expiryDate} ASC NULLS LAST`, asc(lots.receivedAt))
    );
  }

  /**
   * Draws `quantity` from one lot — the primitive the movement service (005-06) calls once per
   * lot per allocation. Never allows `remainingQuantity` to go negative or below 0 at the
   * application layer either, even though the CHECK constraint (`lots_remaining_within_initial`)
   * is the real backstop — this defense-in-depth mirrors every other tenant-scoped repository's
   * two-mechanism discipline. Auto-transitions to `DEPLETED` when the draw exhausts the lot.
   */
  async draw(id: string, quantity: string) {
    return this.runScoped(async (db, scopedWhere) => {
      const rows = await db
        .update(lots)
        .set({
          remainingQuantity: sql`${lots.remainingQuantity} - ${quantity}`,
          status: sql`CASE WHEN ${lots.remainingQuantity} - ${quantity} <= 0 THEN 'DEPLETED'::lot_status ELSE ${lots.status} END`,
        })
        .where(scopedWhere(and(eq(lots.id, id), eq(lots.status, 'ACTIVE'))))
        .returning();

      const updated = rows[0];
      if (!updated) {
        throw new Error(`Cannot draw from lot '${id}' — not found, not ACTIVE, or not in this organization.`);
      }
      return updated;
    });
  }
}
