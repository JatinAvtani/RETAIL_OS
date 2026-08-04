import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { posItems, type salesSourceEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

export type SalesSource = (typeof salesSourceEnum.enumValues)[number];

/**
 * 006-01's schema-task repository: proves `pos_items` is real, tenant-isolated, and idempotent on
 * `(store_id, source, external_id)` (a catalog sync re-run must not create duplicate rows for the
 * same vendor item). Deliberately narrow — mapping a POS item to a MenuItem (006-11) and the real
 * Square catalog sync (006-04) are separate, later tasks; this class only proves the table itself.
 */
export class PosItemRepository extends TenantScopedRepository<typeof posItems> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, posItems, organizationId);
  }

  /**
   * Upserts one catalog item by its natural key `(store, source, external_id)` — a catalog sync
   * calling this repeatedly for the same vendor item must converge on one row, not accumulate
   * duplicates. `lastSeenAt` always advances to `now()` on conflict, which is how a future
   * "mark items not seen in the last sync as delisted" job would detect a deleted-upstream item —
   * that job itself is out of scope here (006-04).
   */
  async upsert(input: {
    id: string;
    storeId: string;
    source: SalesSource;
    externalId: string;
    name: string;
    price?: string;
    currency?: string;
    category?: string;
  }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(posItems)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          storeId: input.storeId,
          source: input.source,
          externalId: input.externalId,
          name: input.name,
          ...(input.price !== undefined ? { price: input.price } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [posItems.storeId, posItems.source, posItems.externalId],
          set: {
            name: input.name,
            ...(input.price !== undefined ? { price: input.price } : {}),
            ...(input.currency !== undefined ? { currency: input.currency } : {}),
            ...(input.category !== undefined ? { category: input.category } : {}),
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning()
    );
    const row = rows[0];
    if (!row) {
      throw new Error('POS item upsert returned no row.');
    }
    return row;
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(posItems)
        .where(scopedWhere(eq(posItems.id, id)))
    );
    return rows[0] ?? null;
  }

  /** The 006-11 mapping-UI read path: unmapped items, most-sold first is a later join this method doesn't attempt yet — plain oldest-first for now. */
  async findUnmapped(storeId?: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(posItems)
        .where(
          scopedWhere(
            storeId
              ? and(eq(posItems.mappingStatus, 'UNMAPPED'), eq(posItems.storeId, storeId))
              : eq(posItems.mappingStatus, 'UNMAPPED')
          )
        )
        .orderBy(posItems.lastSeenAt)
    );
  }

  /** Confirms a mapping — human-confirmed only (I9), same convention as `UnmappedSaleRepository.resolve`. */
  async mapToMenuItem(id: string, menuItemId: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(posItems)
        .set({ menuItemId, mappingStatus: 'MAPPED', updatedAt: new Date() })
        .where(scopedWhere(eq(posItems.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }
}
