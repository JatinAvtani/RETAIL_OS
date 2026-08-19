import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId, type CurrencyCode } from '@retailos/domain';
import * as schema from '../schema/index';
import { unmappedSales } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * earlier work's quarantine queue repository. `unmappedSales` carries a direct `organization_id`
 * column, so this extends `TenantScopedRepository` normally, unlike `InvitationRepository`'s
 * token-scoped half — there is no pre-tenant-context lookup here, a caller always already knows
 * which organization a sale line belongs to.
 */
export class UnmappedSaleRepository extends TenantScopedRepository<typeof unmappedSales> {
  constructor(db: Db, organizationId: string) {
    super(db, unmappedSales, organizationId);
  }

  /**
   * Quarantines one unmapped sale line. Revenue is recorded here directly (not looked up via a
   * join later) so revenue recognition never depends on this row ever being resolved — the
   * decoupling the plan's acceptance criterion calls for.
   */
  async quarantine(input: {
    storeId: string;
    posItemExternalId: string;
    posItemName: string;
    quantitySold: string;
    revenue: string;
    currency: CurrencyCode;
    occurredAt: Date;
    sourceType: string;
    sourceId?: string;
  }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(unmappedSales)
        .values({
          id: generateId(),
          organizationId: this.organizationId,
          storeId: input.storeId,
          posItemExternalId: input.posItemExternalId,
          posItemName: input.posItemName,
          quantitySold: input.quantitySold,
          revenue: input.revenue,
          currency: input.currency,
          occurredAt: input.occurredAt,
          sourceType: input.sourceType,
          ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        })
        .returning()
    );
    const created = rows[0];
    if (!created) {
      throw new Error('Unmapped sale insert returned no row.');
    }
    return created;
  }

  /** The queue view: unresolved rows only, oldest first, matching the index built for this read path. */
  async findUnresolved(storeId?: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(unmappedSales)
        .where(
          scopedWhere(
            storeId
              ? and(eq(unmappedSales.status, 'UNRESOLVED'), eq(unmappedSales.storeId, storeId))
              : eq(unmappedSales.status, 'UNRESOLVED')
          )
        )
        .orderBy(unmappedSales.occurredAt)
    );
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(unmappedSales)
        .where(scopedWhere(eq(unmappedSales.id, id)))
    );
    return rows[0] ?? null;
  }

  /**
   * Resolves a quarantined row to a real menu item — a human confirms the mapping (I9: this is
   * never automatic). Does NOT retroactively post consumption for the historical sale; a caller
   * that wants that behavior does so explicitly via `SaleConsumptionService`, separately. This
   * method only records that the mapping is now known, for future sales of the same POS item.
   */
  async resolve(id: string, menuItemId: string, resolvedByUserId: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(unmappedSales)
        .set({
          status: 'RESOLVED',
          resolvedMenuItemId: menuItemId,
          resolvedAt: new Date(),
          resolvedByUserId,
        })
        .where(scopedWhere(eq(unmappedSales.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  /** Marks a row as deliberately not needing a mapping (e.g. a gift card or service charge line). */
  async ignore(id: string, resolvedByUserId: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(unmappedSales)
        .set({
          status: 'IGNORED',
          resolvedAt: new Date(),
          resolvedByUserId,
        })
        .where(scopedWhere(eq(unmappedSales.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }
}
