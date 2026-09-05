import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from './schema/index';
import { categories, products, suppliers, supplierProducts, lots, units } from './schema/index';
import { generateId } from '@retailos/domain';
import { setUpTwoTenants, type TwoTenantFixture } from './test-support/tenant-fixture';
import { createScopedDb } from './tenant-repository';
import { ProductRepository } from './repositories/product-repository';

const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

/**
 * Proves the compound tenant-aware FKs added in `drizzle/0054_compound_tenant_fks.sql` are real,
 * enforced database constraints — not just RLS's already-tested query-time filtering
 * (`rls-only.cross-tenant.test.ts`). Before this migration, every FK in this schema was a plain
 * single-column reference to a parent's `id`, so a same-organization application bug (a copy-paste
 * error assembling an insert, a wrong variable) could physically write a row referencing a
 * DIFFERENT organization's parent — RLS blocks READING it back cross-tenant, but nothing in the
 * schema itself blocked the WRITE. This test proves the write itself is now rejected, using the
 * admin (BYPASSRLS) connection specifically so RLS cannot be the thing silently doing the blocking —
 * only a real `FOREIGN KEY (organization_id, ...) REFERENCES parent(organization_id, id)` constraint
 * can reject an insert here.
 */
describe('compound tenant-aware foreign keys', () => {
  let fixture: TwoTenantFixture;
  const client = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(client, { schema });
  const appClient = postgres(APP_CONNECTION_STRING);
  const appDb = createScopedDb(appClient);

  beforeAll(async () => {
    fixture = await setUpTwoTenants();
  });

  afterAll(async () => {
    await fixture.cleanup();
    await client.end();
    await appClient.end();
  });

  it('rejects a products.category_id pointing at a DIFFERENT organization\'s category', async () => {
    const categoryId = generateId();
    await adminDb.insert(categories).values({
      id: categoryId,
      organizationId: fixture.tenantB.organizationId,
      name: 'Tenant B Category',
      path: `/${categoryId}`,
    });

    const [kgUnit] = await adminDb.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));

    await expect(
      adminDb.insert(products).values({
        id: generateId(),
        organizationId: fixture.tenantA.organizationId,
        sku: `CROSS-ORG-CATEGORY-${generateId()}`,
        name: 'Cross-org category product',
        categoryId, // Tenant B's category, referenced from a Tenant A product — must be rejected.
        baseUnitId: kgUnit!.id,
        type: 'INGREDIENT',
      })
    ).rejects.toThrow(/violates foreign key constraint "products_category_org_fk"/);

    await adminDb.delete(categories).where(eq(categories.id, categoryId));
  });

  it('accepts a products.category_id pointing at the SAME organization\'s category (the constraint is not overly strict)', async () => {
    const categoryId = generateId();
    await adminDb.insert(categories).values({
      id: categoryId,
      organizationId: fixture.tenantA.organizationId,
      name: 'Tenant A Category',
      path: `/${categoryId}`,
    });

    const [kgUnit] = await adminDb.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();

    await expect(
      adminDb.insert(products).values({
        id: productId,
        organizationId: fixture.tenantA.organizationId,
        sku: `SAME-ORG-CATEGORY-${generateId()}`,
        name: 'Same-org category product',
        categoryId,
        baseUnitId: kgUnit!.id,
        type: 'INGREDIENT',
      })
    ).resolves.not.toThrow();

    await adminDb.delete(products).where(eq(products.id, productId));
    await adminDb.delete(categories).where(eq(categories.id, categoryId));
  });

  it('accepts a NULL products.category_id regardless of organization (an uncategorized product)', async () => {
    const [kgUnit] = await adminDb.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();

    await expect(
      adminDb.insert(products).values({
        id: productId,
        organizationId: fixture.tenantA.organizationId,
        sku: `NO-CATEGORY-${generateId()}`,
        name: 'Uncategorized product',
        categoryId: null,
        baseUnitId: kgUnit!.id,
        type: 'INGREDIENT',
      })
    ).resolves.not.toThrow();

    await adminDb.delete(products).where(eq(products.id, productId));
  });

  it('rejects a goods_receipts.supplier_id pointing at a DIFFERENT organization\'s supplier (raw SQL, since goods_receipts has more required FKs than this test needs to set up)', async () => {
    const supplierId = generateId();
    await adminDb.insert(suppliers).values({
      id: supplierId,
      organizationId: fixture.tenantB.organizationId,
      name: 'Tenant B Supplier',
    });

    await expect(
      client`
        INSERT INTO goods_receipts (id, organization_id, store_id, supplier_id, received_at)
        VALUES (${generateId()}, ${fixture.tenantA.organizationId}, ${fixture.tenantA.storeId}, ${supplierId}, now())
      `
    ).rejects.toThrow(/violates foreign key constraint "goods_receipts_supplier_org_fk"/);

    await adminDb.delete(suppliers).where(eq(suppliers.id, supplierId));
  });

  it('rejects a purchase_order_lines.supplier_product_id pointing at a DIFFERENT organization\'s supplier_product (migration 0055)', async () => {
    const [kgUnit] = await adminDb.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productRepoA = new ProductRepository(appDb, fixture.tenantA.organizationId);
    const productA = await productRepoA.create({
      id: generateId(),
      sku: `FK-BATCH2-PO-PRODUCT-${generateId()}`,
      name: 'Batch 2 FK test product',
      baseUnitId: kgUnit!.id,
      type: 'INGREDIENT',
    });

    const supplierId = generateId();
    await adminDb.insert(suppliers).values({ id: supplierId, organizationId: fixture.tenantB.organizationId, name: 'Tenant B Supplier (batch 2)' });
    const supplierProductId = generateId();
    await adminDb.insert(supplierProducts).values({
      id: supplierProductId,
      organizationId: fixture.tenantB.organizationId,
      supplierId,
      productId: productA.id, // cross-org reference is fine for THIS row's own purposes — it isn't what's under test
      supplierSku: `BATCH2-SKU-${generateId()}`,
    });

    const purchaseOrderId = generateId();
    await adminDb.insert(schema.purchaseOrders).values({
      id: purchaseOrderId,
      organizationId: fixture.tenantA.organizationId,
      storeId: fixture.tenantA.storeId,
      supplierId,
      poNumber: `FK-BATCH2-PO-${generateId()}`,
      currency: 'USD',
    });

    await expect(
      client`
        INSERT INTO purchase_order_lines (id, organization_id, purchase_order_id, supplier_product_id, product_id, quantity_order_units, conversion_to_base, quantity_base_units, unit_price, line_total, line_number)
        VALUES (${generateId()}, ${fixture.tenantA.organizationId}, ${purchaseOrderId}, ${supplierProductId}, ${productA.id}, 1, 1, 1, 10.00, 10.00, 1)
      `
    ).rejects.toThrow(/violates foreign key constraint "purchase_order_lines_supplier_product_org_fk"/);

    await adminDb.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, purchaseOrderId));
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.id, supplierProductId));
    await adminDb.delete(suppliers).where(eq(suppliers.id, supplierId));
    await adminDb.delete(schema.productVariants).where(eq(schema.productVariants.productId, productA.id));
    await adminDb.delete(products).where(eq(products.id, productA.id));
  });

  it('rejects an invoice_match_lines.product_id pointing at a DIFFERENT organization\'s product (migration 0055)', async () => {
    const [kgUnit] = await adminDb.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productRepoB = new ProductRepository(appDb, fixture.tenantB.organizationId);
    const productB = await productRepoB.create({
      id: generateId(),
      sku: `FK-BATCH2-INVOICE-PRODUCT-${generateId()}`,
      name: 'Batch 2 invoice FK test product',
      baseUnitId: kgUnit!.id,
      type: 'INGREDIENT',
    });

    const documentId = generateId();
    await adminDb.insert(schema.documents).values({
      id: documentId,
      organizationId: fixture.tenantA.organizationId,
      storeId: fixture.tenantA.storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      status: 'UPLOADED',
      storageKey: `${fixture.tenantA.organizationId}/fk-batch2-probe.pdf`,
      contentHash: `fk-batch2-probe-hash-${generateId()}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    const supplierIdForMatch = generateId();
    await adminDb.insert(suppliers).values({ id: supplierIdForMatch, organizationId: fixture.tenantA.organizationId, name: 'Tenant A Supplier (batch 2 invoice match)' });

    const invoiceMatchId = generateId();
    await adminDb.insert(schema.invoiceMatches).values({
      id: invoiceMatchId,
      organizationId: fixture.tenantA.organizationId,
      documentId,
      storeId: fixture.tenantA.storeId,
      supplierId: supplierIdForMatch,
    });

    await expect(
      client`
        INSERT INTO invoice_match_lines (id, organization_id, invoice_match_id, invoice_line_index, variance_type, variance_severity, explanation, product_id)
        VALUES (${generateId()}, ${fixture.tenantA.organizationId}, ${invoiceMatchId}, 1, 'UNORDERED_ITEM', 'NONE', 'FK batch 2 test probe', ${productB.id})
      `
    ).rejects.toThrow(/violates foreign key constraint "invoice_match_lines_product_org_fk"/);

    await adminDb.delete(schema.invoiceMatches).where(eq(schema.invoiceMatches.id, invoiceMatchId));
    await adminDb.delete(schema.documents).where(eq(schema.documents.id, documentId));
    await adminDb.delete(suppliers).where(eq(suppliers.id, supplierIdForMatch));
    await adminDb.delete(schema.productVariants).where(eq(schema.productVariants.productId, productB.id));
    await adminDb.delete(products).where(eq(products.id, productB.id));
  });

  it('rejects a stock_movements.lot_id pointing at a DIFFERENT organization\'s lot (migration 0055)', async () => {
    const [kgUnit] = await adminDb.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productRepoA = new ProductRepository(appDb, fixture.tenantA.organizationId);
    const productA = await productRepoA.create({
      id: generateId(),
      sku: `FK-BATCH2-MOVEMENT-PRODUCT-${generateId()}`,
      name: 'Batch 2 movement FK test product',
      baseUnitId: kgUnit!.id,
      type: 'INGREDIENT',
    });
    const variantA = (await productRepoA.findVariants(productA.id))[0]!;

    const lotId = generateId();
    await adminDb.insert(lots).values({
      id: lotId,
      organizationId: fixture.tenantB.organizationId,
      storeId: fixture.tenantB.storeId,
      productId: productA.id,
      variantId: variantA.id,
      receivedAt: new Date(),
      initialQuantity: '10.000000',
      remainingQuantity: '10.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });

    await expect(
      client`
        INSERT INTO stock_movements (id, organization_id, store_id, product_id, variant_id, lot_id, movement_type, quantity, currency, occurred_at, source_type)
        VALUES (${generateId()}, ${fixture.tenantA.organizationId}, ${fixture.tenantA.storeId}, ${productA.id}, ${variantA.id}, ${lotId}, 'SALE_CONSUMPTION', -1, 'USD', now(), 'manual')
      `
    ).rejects.toThrow(/violates foreign key constraint "stock_movements_lot_org_fk"/);

    await adminDb.delete(lots).where(eq(lots.id, lotId));
    await adminDb.delete(schema.productVariants).where(eq(schema.productVariants.productId, productA.id));
    await adminDb.delete(products).where(eq(products.id, productA.id));
  });
});
