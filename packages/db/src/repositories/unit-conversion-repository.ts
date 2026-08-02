import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { unitConversions } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * The stored side of the conversion graph (spec 07 §7.3). Resolution order — product-specific
 * row first, then the global (productId IS NULL) row, then "not found" — is enforced here, not
 * left to callers, so there is exactly one place that can get I6's resolution order wrong.
 * packages/domain's ConversionTable type is the pure-function consumer of what this returns; this
 * class is the only thing in the codebase allowed to query unit_conversions directly.
 */
export class UnitConversionRepository extends TenantScopedRepository<typeof unitConversions> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, unitConversions, organizationId);
  }

  /**
   * Product-specific → global → null (never a guess). Returns the raw factor row; converting the
   * factor into an actual Quantity transformation is packages/domain's job, not this repository's
   * (I1/I2 spirit — this is data access, not business computation).
   */
  async findFactor(fromUnitId: string, toUnitId: string, productId?: string) {
    if (productId) {
      const specific = await this.runScoped((db, scopedWhere) =>
        db
          .select()
          .from(unitConversions)
          .where(
            scopedWhere(
              and(
                eq(unitConversions.fromUnitId, fromUnitId),
                eq(unitConversions.toUnitId, toUnitId),
                eq(unitConversions.productId, productId)
              )
            )
          )
      );
      if (specific[0]) return specific[0];
    }

    const global = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(unitConversions)
        .where(
          scopedWhere(
            and(
              eq(unitConversions.fromUnitId, fromUnitId),
              eq(unitConversions.toUnitId, toUnitId),
              isNull(unitConversions.productId)
            )
          )
        )
    );
    return global[0] ?? null;
  }

  async create(input: {
    id: string;
    fromUnitId: string;
    toUnitId: string;
    factor: string;
    productId?: string;
  }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(unitConversions)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          fromUnitId: input.fromUnitId,
          toUnitId: input.toUnitId,
          productId: input.productId ?? null,
          factor: input.factor,
        })
        .returning()
    );
    return rows[0];
  }
}
