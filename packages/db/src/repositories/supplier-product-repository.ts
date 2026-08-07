import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { supplierProducts } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * Spec 05 §5.3.2: a fuzzy match only ever *suggests* a mapping. `create` always inserts with
 * `isConfirmed: false` — there is no code path in this repository that creates an already-confirmed
 * row, because a mapping earns confirmation only through a human explicitly calling `confirm()`.
 * A wrong auto-mapping corrupts cost data for months, so this asymmetry (easy to create, deliberate
 * extra step to confirm) is load-bearing, not an oversight.
 */
export class SupplierProductRepository extends TenantScopedRepository<typeof supplierProducts> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, supplierProducts, organizationId);
  }

  async findAll() {
    return this.runScoped((db, scopedWhere) => db.select().from(supplierProducts).where(scopedWhere()));
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(supplierProducts)
        .where(scopedWhere(eq(supplierProducts.id, id)))
    );
    return rows[0] ?? null;
  }

  /**
   * 007-10: looks up an existing mapping (confirmed or not) for one exact (supplier, SKU) pair —
   * the real DB unique index (`supplier_products_supplier_sku_unique` on
   * `organization_id, supplier_id, supplier_sku`) guarantees at most one row, so this is a genuine
   * lookup, not a "pick the first of several" convenience. Used by the correction-capture flow to
   * decide confirm-existing vs. create-new when a reviewer maps a line's SKU to a product.
   */
  async findBySupplierAndSku(supplierId: string, supplierSku: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(supplierProducts)
        .where(scopedWhere(and(eq(supplierProducts.supplierId, supplierId), eq(supplierProducts.supplierSku, supplierSku))))
    );
    return rows[0] ?? null;
  }

  /** Only confirmed mappings — the one query cost calculation is allowed to read from (I7: an
   * unconfirmed mapping is not "cost $0," it's "no mapping exists yet"). */
  async findConfirmedForProduct(productId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(supplierProducts)
        .where(scopedWhere(and(eq(supplierProducts.productId, productId), eq(supplierProducts.isConfirmed, true))))
    );
  }

  async create(input: {
    id: string;
    supplierId: string;
    productId: string;
    supplierSku: string;
    variantId?: string;
    supplierDescription?: string;
    packSize?: string;
    packUnitId?: string;
    conversionToBase?: string;
  }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(supplierProducts)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          supplierId: input.supplierId,
          productId: input.productId,
          variantId: input.variantId ?? null,
          supplierSku: input.supplierSku,
          supplierDescription: input.supplierDescription ?? null,
          packSize: input.packSize ?? null,
          packUnitId: input.packUnitId ?? null,
          conversionToBase: input.conversionToBase ?? null,
          isConfirmed: false,
        })
        .returning()
    );
    const created = rows[0];
    if (!created) {
      throw new Error('Supplier product insert returned no row.');
    }
    return created;
  }

  /** The human-confirmation step. Permanent — there is no `unconfirm`. */
  async confirm(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(supplierProducts)
        .set({ isConfirmed: true })
        .where(scopedWhere(eq(supplierProducts.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }
}
