import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { productVariants, products } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';
import { generateId } from '@retailos/domain';

type ProductType = 'INGREDIENT' | 'SELLABLE' | 'BOTH';
type TrackingPolicy = 'NONE' | 'LOT' | 'SERIAL';

/**
 * "Every product gets a default variant on creation" (plan.md) is enforced here, not left to
 * callers — `create` always inserts both rows in the same transaction. Food service never has to
 * think about variants; fashion/grocery get the identical schema with real variant rows added
 * later via `addVariant`, no migration needed.
 */
export class ProductRepository extends TenantScopedRepository<typeof products> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, products, organizationId);
  }

  async findAll() {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(products)
        .where(scopedWhere(isNull(products.deletedAt)))
    );
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(products)
        .where(scopedWhere(and(eq(products.id, id), isNull(products.deletedAt))))
    );
    return rows[0] ?? null;
  }

  async create(input: {
    id: string;
    sku: string;
    name: string;
    baseUnitId: string;
    type: ProductType;
    categoryId?: string;
    trackingPolicy?: TrackingPolicy;
    isPerishable?: boolean;
  }) {
    return this.runScoped(async (db) => {
      const inserted = await db
        .insert(products)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          sku: input.sku,
          name: input.name,
          categoryId: input.categoryId ?? null,
          baseUnitId: input.baseUnitId,
          type: input.type,
          trackingPolicy: input.trackingPolicy ?? 'NONE',
          isPerishable: input.isPerishable ?? false,
        })
        .returning();
      const product = inserted[0];
      if (!product) {
        throw new Error('Product insert returned no row.');
      }

      await db.insert(productVariants).values({
        id: generateId(),
        productId: product.id,
        name: input.name,
        isDefault: true,
      });

      return product;
    });
  }

  /** Adds a NON-default variant. The default variant only ever comes from `create`. */
  async addVariant(productId: string, input: { name: string; sku?: string; barcode?: string }) {
    const product = await this.findById(productId);
    if (!product) {
      throw new Error(`Cannot add a variant to product '${productId}' — not found in this organization.`);
    }

    const rows = await this.runScoped((db) =>
      db
        .insert(productVariants)
        .values({
          id: generateId(),
          productId,
          name: input.name,
          sku: input.sku ?? null,
          barcode: input.barcode ?? null,
          isDefault: false,
        })
        .returning()
    );
    return rows[0];
  }

  async findVariants(productId: string) {
    const product = await this.findById(productId);
    if (!product) return [];

    return this.runScoped((db) =>
      db
        .select()
        .from(productVariants)
        .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
    );
  }

  /**
   * Edits the fields a catalog UI actually lets a user change post-creation — not `baseUnitId`
   * (retroactively changing the unit every stock/recipe/costing calculation for this product is
   * expressed in would silently corrupt existing quantities, I6) and not `sku` (the partial unique
   * index keys off it; changing it live is a separate, deliberate decision this task doesn't need).
   */
  async update(
    productId: string,
    input: { name?: string; categoryId?: string | null; isPerishable?: boolean; defaultShelfLifeDays?: number | null }
  ) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(products)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
          ...(input.isPerishable !== undefined && { isPerishable: input.isPerishable }),
          ...(input.defaultShelfLifeDays !== undefined && { defaultShelfLifeDays: input.defaultShelfLifeDays }),
        })
        .where(scopedWhere(and(eq(products.id, productId), isNull(products.deletedAt))))
        .returning()
    );
    return rows[0] ?? null;
  }

  /**
   * `imageKey` is an object storage key (packages/storage), never a URL — spec 14 §14.5: objects
   * are never public, every read goes through a short-lived presigned URL generated on demand.
   * The caller (apps/api's `confirmImageUpload`) is responsible for verifying the object's actual
   * bytes before calling this; this method trusts the key it's given the same way every other
   * write in this class trusts its caller's already-validated input.
   */
  async setImageKey(productId: string, imageKey: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(products)
        .set({ imageKey })
        .where(scopedWhere(eq(products.id, productId)))
        .returning()
    );
    const updated = rows[0];
    if (!updated) {
      throw new Error(`Cannot set imageKey for product '${productId}' — not found in this organization.`);
    }
    return updated;
  }
}
