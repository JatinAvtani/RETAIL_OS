import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { supplierPrices, supplierProducts } from '../schema/index';
import { withTenantContext, type Tx } from '../tenant-context';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Not a TenantScopedRepository: `supplier_prices` has no `organization_id` column of its own (see
 * schema comment — a price only means anything in the context of its `supplierProductId`). RLS
 * still enforces tenant isolation via the subquery-based policy on this table; this class just
 * can't use the base class's direct-column WHERE-ANDing, so `withTenantContext` is called
 * explicitly instead, same effect via a different mechanism (mirroring what
 * TenantScopedRepository.runScoped does internally).
 */
export class SupplierPriceRepository {
  private readonly db: Db;
  private readonly organizationId: string;

  constructor(db: Db, organizationId: string) {
    if (!organizationId || organizationId.trim().length === 0) {
      throw new Error('SupplierPriceRepository constructed without an organizationId.');
    }
    this.db = db;
    this.organizationId = organizationId;
  }

  private async runScoped<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
    return this.db.transaction((tx) => withTenantContext(tx, this.organizationId, () => fn(tx)));
  }

  /** Effective-dated history for a supplier product, newest first. */
  async findHistory(supplierProductId: string) {
    return this.runScoped((tx) =>
      tx
        .select()
        .from(supplierPrices)
        .where(eq(supplierPrices.supplierProductId, supplierProductId))
        .orderBy(desc(supplierPrices.validFrom))
    );
  }

  /** The currently-effective price (validTo IS NULL), or null if none exists. */
  async findCurrent(supplierProductId: string) {
    const rows = await this.runScoped((tx) =>
      tx
        .select()
        .from(supplierPrices)
        .where(and(eq(supplierPrices.supplierProductId, supplierProductId), isNull(supplierPrices.validTo)))
    );
    return rows[0] ?? null;
  }

  /**
   * earlier work's price-anomaly gate input: confirmed trailing unit prices for one exact
   * (supplierId, supplierSku) pair, most recent `limit` rows. Deliberately joins only through
   * `supplierProducts` rows with `isConfirmed = true` — an unconfirmed/fuzzy-matched mapping
   * must never silently feed a validation gate that blocks or waves through real
   * invoices. Returns an empty array (never a fabricated single price) when no confirmed mapping
   * exists for this exact SKU string.
   *
   * `currency`, when given, restricts trailing prices to the SAME currency as the value being
   * checked — comparing a ₹450 extracted price against a $4.50 trailing history would flag every
   * normal invoice as a 100x anomaly (or worse, silently PASS a genuinely wrong price whose
   * magnitude happens to land back in range by coincidence of the FX ratio). Omitted only by
   * callers that haven't resolved a currency yet; a real gate call always passes one.
   */
  async findConfirmedTrailingPricesBySupplierSku(supplierId: string, supplierSku: string, currency?: string, limit = 5) {
    return this.runScoped((tx) =>
      tx
        .select({ unitPrice: supplierPrices.unitPrice, validFrom: supplierPrices.validFrom, currency: supplierPrices.currency })
        .from(supplierPrices)
        .innerJoin(supplierProducts, eq(supplierProducts.id, supplierPrices.supplierProductId))
        .where(
          and(
            eq(supplierProducts.supplierId, supplierId),
            eq(sql`lower(${supplierProducts.supplierSku})`, supplierSku.trim().toLowerCase()),
            eq(supplierProducts.isConfirmed, true),
            ...(currency !== undefined ? [eq(sql`lower(${supplierPrices.currency})`, currency.trim().toLowerCase())] : [])
          )
        )
        .orderBy(desc(supplierPrices.validFrom))
        .limit(limit)
    );
  }

  /**
   * A price change is NEVER an UPDATE of the old row's values (I3's append-preferred spirit,
   * applied to cost history) — it closes the currently-open row (sets validTo = the new row's
   * validFrom) and inserts a fresh one, both in one transaction. The exclusion constraint
   * (supplier_prices_no_overlapping_validity) is the backstop that makes a mistake here a hard
   * database error, not a silently wrong historical cost.
   */
  async recordNewPrice(input: {
    id: string;
    supplierProductId: string;
    unitPrice: string;
    currency: string;
    validFrom: Date;
    sourceDocumentId?: string;
  }) {
    return this.runScoped(async (tx) => {
      const current = await tx
        .select()
        .from(supplierPrices)
        .where(and(eq(supplierPrices.supplierProductId, input.supplierProductId), isNull(supplierPrices.validTo)));

      if (current[0]) {
        await tx.update(supplierPrices).set({ validTo: input.validFrom }).where(eq(supplierPrices.id, current[0].id));
      }

      const rows = await tx
        .insert(supplierPrices)
        .values({
          id: input.id,
          supplierProductId: input.supplierProductId,
          unitPrice: input.unitPrice,
          currency: input.currency,
          validFrom: input.validFrom,
          sourceDocumentId: input.sourceDocumentId ?? null,
        })
        .returning();

      const created = rows[0];
      if (!created) {
        throw new Error('Supplier price insert returned no row.');
      }
      return created;
    });
  }
}
