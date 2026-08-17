import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { stockParLevels } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * 005-09's storage repository — pure data, confirmed with the user: no reorder-calculation logic
 * lives here (that's 008-02), no event emission (`stock.below_par` isn't wired to anything in this
 * task, same detection-only precedent as `findStockLevelDrift`, 005-04).
 */
export class ParLevelRepository extends TenantScopedRepository<typeof stockParLevels> {
  constructor(db: Db, organizationId: string) {
    super(db, stockParLevels, organizationId);
  }

  /**
   * Upserts the par level / reorder point for one (store, product, variant). Either value may be
   * `undefined` to leave that column unset — `undefined` maps to `null`, never `0` (I7): a
   * threshold that hasn't been configured yet must stay distinguishable from a threshold of zero.
   */
  async setParLevel(input: {
    storeId: string;
    productId: string;
    variantId: string;
    parLevel?: string;
    reorderPoint?: string;
  }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(stockParLevels)
        .values({
          organizationId: this.organizationId,
          storeId: input.storeId,
          productId: input.productId,
          variantId: input.variantId,
          parLevel: input.parLevel ?? null,
          reorderPoint: input.reorderPoint ?? null,
        })
        .onConflictDoUpdate({
          target: [stockParLevels.storeId, stockParLevels.productId, stockParLevels.variantId],
          set: {
            parLevel: input.parLevel ?? null,
            reorderPoint: input.reorderPoint ?? null,
            updatedAt: new Date(),
          },
        })
        .returning()
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Par level upsert returned no row.');
    }
    return row;
  }

  async find(storeId: string, productId: string, variantId: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(stockParLevels)
        .where(
          scopedWhere(
            and(
              eq(stockParLevels.storeId, storeId),
              eq(stockParLevels.productId, productId),
              eq(stockParLevels.variantId, variantId)
            )
          )
        )
    );
    return rows[0] ?? null;
  }

  async findAllForStore(storeId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(stockParLevels)
        .where(scopedWhere(eq(stockParLevels.storeId, storeId)))
    );
  }

  /**
   * `items_below_reorder_point`'s real input (009-15) — a tenant-scoped equivalent of
   * `findBelowParLevels` (`packages/db/src/below-par.ts`, 005-09), same reasoning as
   * `StockLevelRepository.findExpiringLots`/`findDriftForOrg`: the original is a deliberate
   * cross-tenant admin sweep, this is the one-store, app-role-scoped version this catalog entry can
   * actually call. `INNER JOIN` (not `LEFT`), matching the original exactly — a product with no
   * `stock_par_levels` row at all has no reorder point configured, a genuinely different state from
   * "configured and currently satisfied," and confirmed with the user this metric is the SIMPLE
   * literal threshold check, not `suggestReorder`'s richer supplier-grouped suggestion engine.
   */
  async findBelowReorderPointForStore(storeId: string) {
    const rows = await this.runScoped((db) =>
      db.execute<{
        product_id: string;
        variant_id: string;
        quantity_on_hand: string;
        reorder_point: string;
      }>(sql`
        SELECT
          sl.product_id,
          sl.variant_id,
          sl.quantity AS quantity_on_hand,
          pl.reorder_point
        FROM stock_levels sl
        INNER JOIN stock_par_levels pl
          ON pl.store_id = sl.store_id
         AND pl.product_id = sl.product_id
         AND pl.variant_id = sl.variant_id
         AND pl.organization_id = ${this.organizationId}
        WHERE sl.organization_id = ${this.organizationId}
          AND sl.store_id = ${storeId}
          AND pl.reorder_point IS NOT NULL
          AND sl.quantity <= pl.reorder_point
      `)
    );
    return rows.map((row) => ({
      productId: row.product_id,
      variantId: row.variant_id,
      quantityOnHand: row.quantity_on_hand,
      reorderPoint: row.reorder_point,
    }));
  }
}
