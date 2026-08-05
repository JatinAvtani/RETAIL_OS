import { and, eq, lt } from 'drizzle-orm';
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
            // A fresh sighting relists an item a prior sync had marked delisted — Square's own
            // is_deleted flag can flip back to false (e.g. a merchant restores an archived item).
            delistedAt: null,
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

  /** The 006-05 orders-sync read path: resolves a line's vendor `catalog_object_id` back to its own `pos_items.id`, so `sales_transaction_lines.posItemId` references the SKU that was actually sold. */
  async findByExternalId(storeId: string, source: SalesSource, externalId: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(posItems)
        .where(scopedWhere(and(eq(posItems.storeId, storeId), eq(posItems.source, source), eq(posItems.externalId, externalId))))
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

  /**
   * 006-04 (plan.md Phase 2): "deleted upstream items are marked, not deleted." Called once, after
   * a full catalog sync has upserted every item Square returned — any row for this store+source
   * whose `lastSeenAt` is still older than `syncStartedAt` was NOT touched by that sync, meaning
   * Square no longer lists it. Never deletes the row (`sales_transaction_lines.posItemId` still
   * references it for historical sales) and is itself idempotent: re-running finds nothing new to
   * mark once every stale row already has a `delistedAt`.
   */
  async markNotSeenSinceAsDelisted(storeId: string, source: SalesSource, syncStartedAt: Date) {
    return this.runScoped((db, scopedWhere) =>
      db
        .update(posItems)
        .set({ delistedAt: new Date(), updatedAt: new Date() })
        .where(
          scopedWhere(
            and(
              eq(posItems.storeId, storeId),
              eq(posItems.source, source),
              lt(posItems.lastSeenAt, syncStartedAt)
            )
          )
        )
        .returning()
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
