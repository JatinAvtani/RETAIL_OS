import { and, eq, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { posItems, type salesSourceEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

export type SalesSource = (typeof salesSourceEnum.enumValues)[number];

export type UnmappedPosItemWithVolume = typeof posItems.$inferSelect & { totalRevenue: string; totalQuantity: string };

/**
 * earlier work's schema-task repository: proves `pos_items` is real, tenant-isolated, and idempotent on
 * `(store_id, source, external_id)` (a catalog sync re-run must not create duplicate rows for the
 * same vendor item). Deliberately narrow — mapping a POS item to a MenuItem and the real
 * Square catalog sync are separate, later tasks; this class only proves the table itself.
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
   * that job itself is out of scope here.
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

  /** The orders-sync read path: resolves a line's vendor `catalog_object_id` back to its own `pos_items.id`, so `sales_transaction_lines.posItemId` references the SKU that was actually sold. */
  async findByExternalId(storeId: string, source: SalesSource, externalId: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(posItems)
        .where(scopedWhere(and(eq(posItems.storeId, storeId), eq(posItems.source, source), eq(posItems.externalId, externalId))))
    );
    return rows[0] ?? null;
  }

  /** The earlier work mapping-UI read path: unmapped items, most-sold first is a later join this method doesn't attempt yet — plain oldest-first for now. */
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
   * The real earlier work mapping-UI read path: unmapped items ranked by trailing sales volume,
   * highest first — the plan's own reasoning ("mapping the top 20 items covers ~80% of revenue")
   * only works if the list is actually sorted that way, unlike the plain `findUnmapped` above.
   * `LEFT JOIN` against a revenue subquery, not `INNER JOIN` — an unmapped item that has never
   * actually sold (freshly synced from the catalog, zero transactions) is still a real unmapped
   * item that needs a decision, so it must still appear, just at the bottom (I7 — the absence of
   * a sales signal is not evidence the item doesn't need mapping). `totalRevenue`/`totalQuantity`
   * default to `'0'`/`'0.000000'` only via `COALESCE` on the LEFT JOIN's non-matching side, which
   * is a real, unambiguous zero (no sales occurred), not a guessed cost or quantity — a different
   * case from defaulting a missing COST to zero, which is the actual pattern I7 forbids.
   */
  async findUnmappedRankedByVolume(storeId?: string): Promise<UnmappedPosItemWithVolume[]> {
    return this.runScoped(async (db) => {
      const rows = await db.execute<{
        id: string;
        organization_id: string;
        store_id: string;
        source: SalesSource;
        external_id: string;
        name: string;
        price: string | null;
        currency: string | null;
        category: string | null;
        menu_item_id: string | null;
        mapping_status: 'UNMAPPED' | 'MAPPED' | 'IGNORED';
        last_seen_at: Date;
        delisted_at: Date | null;
        created_at: Date;
        updated_at: Date;
        total_revenue: string;
        total_quantity: string;
      }>(sql`
        SELECT
          pi.*,
          COALESCE(v.total_revenue, '0') AS total_revenue,
          COALESCE(v.total_quantity, '0.000000') AS total_quantity
        FROM pos_items pi
        LEFT JOIN (
          SELECT stl.pos_item_id, SUM(stl.line_total) AS total_revenue, SUM(stl.quantity) AS total_quantity
          FROM sales_transaction_lines stl
          WHERE stl.organization_id = ${this.organizationId}
          GROUP BY stl.pos_item_id
        ) v ON v.pos_item_id = pi.id
        WHERE pi.organization_id = ${this.organizationId}
          AND pi.mapping_status = 'UNMAPPED'
          ${storeId ? sql`AND pi.store_id = ${storeId}` : sql``}
        ORDER BY COALESCE(v.total_revenue, '0') DESC, pi.last_seen_at
      `);

      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        storeId: row.store_id,
        source: row.source,
        externalId: row.external_id,
        name: row.name,
        price: row.price,
        currency: row.currency,
        category: row.category,
        menuItemId: row.menu_item_id,
        mappingStatus: row.mapping_status,
        lastSeenAt: row.last_seen_at,
        delistedAt: row.delisted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        totalRevenue: row.total_revenue,
        totalQuantity: row.total_quantity,
      }));
    });
  }

  /**
   * "deleted upstream items are marked, not deleted." Called once, after
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

  /**
   * Marks a POS item as genuinely never needing a menu-item mapping (a gift card, a service
   * charge, a tip line) — distinct from `UNMAPPED` ("not yet looked at"), same three-way split
   * `UnmappedSaleRepository`'s `resolve`/`ignore` pair already established. Never clears
   * `menuItemId` — this is only ever called on a row that has none, matching `mapToMenuItem`'s
   * own one-directional convention.
   */
  async ignore(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(posItems)
        .set({ mappingStatus: 'IGNORED', updatedAt: new Date() })
        .where(scopedWhere(eq(posItems.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }
}
