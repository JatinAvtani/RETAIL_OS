import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId } from '@retailos/domain';
import * as schema from '@retailos/db';
import {
  auditLogs,
  categories,
  createDb,
  documents,
  goodsReceiptLines,
  goodsReceipts,
  invoiceMatches,
  invoiceMatchLines,
  lots,
  organizations,
  outboxEvents,
  products,
  productVariants,
  purchaseOrderLines,
  purchaseOrders,
  stockLevels,
  stockMovements,
  stores,
  suppliers,
  supplierProducts,
  supplierPerformanceEvents,
  units,
  withTenantContext,
  DocumentRepository,
  GoodsReceiptRepository,
  InvoiceMatchRepository,
  PurchaseOrderRepository,
  SupplierPerformanceEventRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that all 8 purchasing metrics (spec 12 §F) compute correctly through
 * `executeMetric`, using the same real PO -> receive -> invoice-match fixture pipeline
 * `invoice-match-repository.test.ts` already established and proved correct.
 */
describe('registered purchasing metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient, { schema: schema as never });
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, orgId));
      await adminDb.delete(invoiceMatchLines).where(eq(invoiceMatchLines.organizationId, orgId));
      await adminDb.delete(invoiceMatches).where(eq(invoiceMatches.organizationId, orgId));
      await adminDb.delete(documents).where(eq(documents.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.update(lots).set({ goodsReceiptLineId: null }).where(eq(lots.organizationId, orgId));
      await adminDb.delete(goodsReceiptLines).where(eq(goodsReceiptLines.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(goodsReceipts).where(eq(goodsReceipts.organizationId, orgId));
      await adminDb.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, orgId));
      await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));
      await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await adminDb.delete(products).where(eq(products.organizationId, orgId));
      await adminDb.delete(categories).where(eq(categories.organizationId, orgId));
      await adminDb.delete(suppliers).where(eq(suppliers.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await adminClient.end();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Purchasing Metrics Test Org ${organizationId}`,
      slug: `purchasing-metrics-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' })
      )
    );
    const supplierId = generateId();
    const supplierName = `Purchasing Test Supplier ${supplierId}`;
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () => tx.insert(suppliers).values({ id: supplierId, organizationId, name: supplierName }))
    );
    return { organizationId, storeId, supplierId, supplierName };
  };

  const makeProduct = async (organizationId: string, supplierId: string, categoryId?: string) => {
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    const supplierProductId = generateId();
    const supplierSku = `SKU-${productId}`;
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `PUR-${productId}`,
          name: 'Purchasing Metrics Test Product',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
          ...(categoryId !== undefined ? { categoryId } : {}),
        });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
        await tx.insert(supplierProducts).values({
          id: supplierProductId,
          organizationId,
          supplierId,
          productId,
          supplierSku,
          isConfirmed: true,
        });
      })
    );
    return { productId, variantId, supplierProductId, supplierSku, unitId: eachUnit!.id };
  };

  const createSentPurchaseOrder = async (
    organizationId: string,
    storeId: string,
    supplierId: string,
    supplierProductId: string,
    productId: string,
    unitId: string,
    quantityOrderUnits: string,
    unitPrice: string
  ) => {
    const poRepo = new PurchaseOrderRepository(db, organizationId);
    const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-PUR-${generateId()}`, currency: 'USD' });
    const addLineResult = await poRepo.addLine({
      purchaseOrderId: created.id,
      supplierProductId,
      productId,
      quantityOrderUnits,
      orderUnitId: unitId,
      conversionToBase: '1',
      unitPrice,
      lineNumber: 1,
    });
    if (!addLineResult.ok) throw new Error('addLine failed in test setup');
    await poRepo.applyTransition(created.id, 'SUBMIT', 1);
    await poRepo.applyTransition(created.id, 'APPROVE', 2);
    await poRepo.applyTransition(created.id, 'SEND', 3);
    const lines = await poRepo.findLines(created.id);
    return { purchaseOrderId: created.id, purchaseOrderLineId: lines[0]!.id };
  };

  const receiveAgainstPo = async (
    organizationId: string,
    storeId: string,
    supplierId: string,
    purchaseOrderId: string,
    purchaseOrderLineId: string,
    receivedQuantityBaseUnits: string
  ) => {
    const grRepo = new GoodsReceiptRepository(db, organizationId);
    return grRepo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits, lineNumber: 1 }],
    });
  };

  const createPostedInvoiceDocument = async (organizationId: string, storeId: string) => {
    const documentRepo = new DocumentRepository(db, organizationId);
    const doc = await documentRepo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/purchasing-metrics-test-${generateId()}.pdf`,
      contentHash: `purchasing-metrics-hash-${generateId()}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    return doc.id;
  };

  const auth = (permissions: readonly string[] = ['purchasing:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });

  const from = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const to = () => new Date(Date.now() + 60 * 1000);

  it('total_spend/spend_by_category sum real approved PO line totals for a store, grouped by category', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrg();
    const categoryId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(categories).values({ id: categoryId, organizationId, name: 'Test Category', path: 'test-category' })
      )
    );
    const { productId, supplierProductId, unitId } = await makeProduct(organizationId, supplierId, categoryId);
    // A real, real approved PO: 20 units at $5.00 = $100.00.
    await createSentPurchaseOrder(organizationId, storeId, supplierId, supplierProductId, productId, unitId, '20', '5.00');

    const [totalSpend, spendByCategory] = await Promise.all([
      executeMetric('total_spend', { storeId, from, to: to() }, auth(), plainCtx(organizationId)),
      executeMetric('spend_by_category', { storeId, categoryId, from, to: to() }, auth(), plainCtx(organizationId)),
    ]);
    expect(totalSpend.value).toBe('100.0000');
    expect(spendByCategory.value).toBe('100.0000');
  });

  it('total_spend excludes a PO that never reached APPROVED', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrg();
    const { productId, supplierProductId, unitId } = await makeProduct(organizationId, supplierId);
    const poRepo = new PurchaseOrderRepository(db, organizationId);
    const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-DRAFT-${generateId()}`, currency: 'USD' });
    await poRepo.addLine({
      purchaseOrderId: created.id,
      supplierProductId,
      productId,
      quantityOrderUnits: '20',
      orderUnitId: unitId,
      conversionToBase: '1',
      unitPrice: '5.00',
      lineNumber: 1,
    });
    // Left in DRAFT — never submitted/approved.

    const result = await executeMetric('total_spend', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('0.0000');
  });

  it('price_variance_total sums real quantity-weighted priceVariance from a matched invoice', async () => {
    const { organizationId, storeId, supplierId, supplierName } = await setUpOrg();
    const { productId, supplierProductId, supplierSku, unitId } = await makeProduct(organizationId, supplierId);
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder(
      organizationId,
      storeId,
      supplierId,
      supplierProductId,
      productId,
      unitId,
      '10',
      '50.00'
    );
    await receiveAgainstPo(organizationId, storeId, supplierId, purchaseOrderId, purchaseOrderLineId, '10');
    const documentId = await createPostedInvoiceDocument(organizationId, storeId);

    const invoiceMatchRepo = new InvoiceMatchRepository(db, organizationId);
    // Invoiced at $100 vs PO's $50 for 10 units — real priceVariance of 50.0000 per unit.
    await invoiceMatchRepo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: supplierSku }, quantity: { value: '10' }, unitPrice: { value: '100.00' } }],
    });

    const result = await executeMetric('price_variance_total', { supplierId, from, to: to() }, auth(), plainCtx(organizationId));
    // 50.00 variance * 10 units = 500.00.
    expect(result.value).toBe('500.0000');
  });

  it('po_cycle_time averages real days from PO creation to being sent', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrg();
    const { productId, supplierProductId, unitId } = await makeProduct(organizationId, supplierId);
    await createSentPurchaseOrder(organizationId, storeId, supplierId, supplierProductId, productId, unitId, '5', '2.00');

    const result = await executeMetric('po_cycle_time', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    // The real PO was created and sent within the same test run — a real, small, non-negative day count.
    expect(result.value).not.toBe('unknown');
    expect(Number(result.value)).toBeGreaterThanOrEqual(0);
  });

  it('po_cycle_time is unknown with no sent POs in the period, never a fabricated 0-day average', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const result = await executeMetric('po_cycle_time', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
  });

  it('order_frequency/average_order_value count and average real POs placed with a supplier', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrg();
    const { productId, supplierProductId, unitId } = await makeProduct(organizationId, supplierId);
    await createSentPurchaseOrder(organizationId, storeId, supplierId, supplierProductId, productId, unitId, '10', '5.00');
    await createSentPurchaseOrder(organizationId, storeId, supplierId, supplierProductId, productId, unitId, '10', '15.00');

    const [orderFrequency, averageOrderValue] = await Promise.all([
      executeMetric('order_frequency', { supplierId, from, to: to() }, auth(), plainCtx(organizationId)),
      executeMetric('average_order_value', { supplierId, from, to: to() }, auth(), plainCtx(organizationId)),
    ]);
    expect(orderFrequency.value).toBe('2');
    // (10*5.00 + 10*15.00) / 2 = (50 + 150) / 2 = 100.00.
    expect(averageOrderValue.value).toBe('100.0000');
  });

  it('average_order_value is unknown with zero POs placed, never a fabricated $0 average', async () => {
    const { organizationId, supplierId } = await setUpOrg();
    const result = await executeMetric('average_order_value', { supplierId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
  });

  it('emergency_purchase_rate finds a real receipt with no linked PO', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrg();
    const { productId, variantId, supplierProductId, unitId } = await makeProduct(organizationId, supplierId);
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder(
      organizationId,
      storeId,
      supplierId,
      supplierProductId,
      productId,
      unitId,
      '10',
      '5.00'
    );
    await receiveAgainstPo(organizationId, storeId, supplierId, purchaseOrderId, purchaseOrderLineId, '10');

    // A real walk-in receipt with NO purchase order at all.
    const grRepo = new GoodsReceiptRepository(db, organizationId);
    await grRepo.confirmReceipt({
      storeId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ productId, variantId, receivedQuantityBaseUnits: '5', unitCost: '3.00', currency: 'USD', lineNumber: 1 }],
    });

    const result = await executeMetric('emergency_purchase_rate', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    // 1 emergency receipt out of 2 total = 50%.
    expect(result.value).toBe('50.00');
  });

  it('emergency_purchase_rate is unknown with zero receipts in the period, never a fabricated 0%', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const result = await executeMetric('emergency_purchase_rate', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
  });

  it('price_change_impact reads the real, already-computed variance off a real PRICE_CHANGE event', async () => {
    const { organizationId, supplierId } = await setUpOrg();
    const { productId } = await makeProduct(organizationId, supplierId);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        SupplierPerformanceEventRepository.recordInTx(tx, organizationId, {
          organizationId,
          supplierId,
          eventType: 'PRICE_CHANGE',
          productId,
          expectedValue: '2.000000',
          actualValue: '2.500000',
          variance: '500.000000',
          occurredAt: new Date(),
        })
      )
    );

    const result = await executeMetric('price_change_impact', { supplierId, productId, since }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('500.0000');
  });

  it('price_change_impact is unknown with no PRICE_CHANGE event, never a fabricated zero', async () => {
    const { organizationId, supplierId } = await setUpOrg();
    const { productId } = await makeProduct(organizationId, supplierId);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await executeMetric('price_change_impact', { supplierId, productId, since }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
  });

  it('executeMetric refuses a caller without purchasing:read for a purchasing metric', async () => {
    const { organizationId, storeId } = await setUpOrg();
    await expect(executeMetric('total_spend', { storeId, from, to: to() }, auth([]), plainCtx(organizationId))).rejects.toThrow(
      /purchasing:read/
    );
  });
});
