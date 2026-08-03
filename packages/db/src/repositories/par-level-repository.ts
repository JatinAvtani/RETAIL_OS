import { and, eq } from 'drizzle-orm';
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
}
