import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId } from '@retailos/domain';
import * as schema from '@retailos/db';
import {
  auditLogs,
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
  supplierPrices,
  supplierPerformanceEvents,
  units,
  withTenantContext,
  DocumentRepository,
  GoodsReceiptRepository,
  InvoiceMatchRepository,
  PurchaseOrderRepository,
  SupplierPriceRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import './supplier-catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that all 7 registered supplier metrics compute correctly
 * through `executeMetric`, reusing the same real PO -> receive -> invoice-match fixture pipeline
 * earlier work's own wiring test established, extended with a real `expectedDeliveryDate` so
 * `confirmReceipt`'s own real DELIVERY_ON_TIME/LATE emission fires.
 */
describe('registered supplier metrics', () => {
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
      const orgSupplierProducts = await adminDb
        .select({ id: supplierProducts.id })
        .from(supplierProducts)
        .where(eq(supplierProducts.organizationId, orgId));
      for (const sp of orgSupplierProducts) {
        await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, sp.id));
      }
      await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await adminDb.delete(products).where(eq(products.organizationId, orgId));
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
      name: `Supplier Metrics Test Org ${organizationId}`,
      slug: `supplier-metrics-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' })
      )
    );
    const supplierId = generateId();
    const supplierName = `Supplier Metrics Test Supplier ${supplierId}`;
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () => tx.insert(suppliers).values({ id: supplierId, organizationId, name: supplierName }))
    );
    return { organizationId, storeId, supplierId, supplierName };
  };

  const makeProduct = async (organizationId: string, supplierId: string) => {
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
          sku: `SUP-${productId}`,
          name: 'Supplier Metrics Test Product',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
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
    unitPrice: string,
    expectedDeliveryDate?: Date
  ) => {
    const poRepo = new PurchaseOrderRepository(db, organizationId);
    const created = await poRepo.create({
      storeId,
      supplierId,
      poNumber: `PO-SUP-${generateId()}`,
      currency: 'USD',
      ...(expectedDeliveryDate !== undefined ? { expectedDeliveryDate } : {}),
    });
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
    receivedQuantityBaseUnits: string,
    receivedAt: Date
  ) => {
    const grRepo = new GoodsReceiptRepository(db, organizationId);
    return grRepo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt,
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits, lineNumber: 1 }],
    });
  };

  const createPostedInvoiceDocument = async (organizationId: string, storeId: string) => {
    const documentRepo = new DocumentRepository(db, organizationId);
    const doc = await documentRepo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/supplier-metrics-test-${generateId()}.pdf`,
      contentHash: `supplier-metrics-hash-${generateId()}`,
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

  it('fill_rate/quality_reject_rate derive from real FILL_COMPLETE/FILL_SHORT/QUALITY_REJECT events', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrg();
    const { productId, supplierProductId, unitId } = await makeProduct(organizationId, supplierId);
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
    // Ordered 10, received only 8 -> FILL_SHORT, fill rate 80%.
    await receiveAgainstPo(organizationId, storeId, supplierId, purchaseOrderId, purchaseOrderLineId, '8', new Date());

    const [fillRate, qualityRejectRate] = await Promise.all([
      executeMetric('fill_rate', { supplierId, from, to: to() }, auth(), plainCtx(organizationId)),
      executeMetric('quality_reject_rate', { supplierId, from, to: to() }, auth(), plainCtx(organizationId)),
    ]);
    expect(fillRate.value).toBe('80.00');
    // No discrepancy code on the line -> no QUALITY_REJECT event -> a real 0%, not unknown.
    expect(qualityRejectRate.value).toBe('0.00');
  });

  it('fill_rate is unknown with no fill events for the supplier in the period', async () => {
    const { organizationId, supplierId } = await setUpOrg();
    const result = await executeMetric('fill_rate', { supplierId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
  });

  it('on_time_delivery_rate derives from a real DELIVERY_LATE event', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrg();
    const { productId, supplierProductId, unitId } = await makeProduct(organizationId, supplierId);
    const expectedDeliveryDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder(
      organizationId,
      storeId,
      supplierId,
      supplierProductId,
      productId,
      unitId,
      '10',
      '5.00',
      expectedDeliveryDate
    );
    // Received 2 days AFTER the expected delivery date -> a real DELIVERY_LATE event.
    const receivedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await receiveAgainstPo(organizationId, storeId, supplierId, purchaseOrderId, purchaseOrderLineId, '10', receivedAt);

    const result = await executeMetric('on_time_delivery_rate', { supplierId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('0.00');
  });

  it('invoice_accuracy_rate derives from a real INVOICE_CLEAN event', async () => {
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
      '4.50'
    );
    await receiveAgainstPo(organizationId, storeId, supplierId, purchaseOrderId, purchaseOrderLineId, '10', new Date());
    const documentId = await createPostedInvoiceDocument(organizationId, storeId);

    const invoiceMatchRepo = new InvoiceMatchRepository(db, organizationId);
    // Invoiced at the SAME price/quantity as the PO -> a real CLEAN match.
    await invoiceMatchRepo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: supplierSku }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
    });

    const result = await executeMetric('invoice_accuracy_rate', { supplierId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('100.00');
  });

  it('lead_time_actual/lead_time_variance average and spread real days from sentAt to receivedAt', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrg();
    const { productId, supplierProductId, unitId } = await makeProduct(organizationId, supplierId);

    // The real applyTransition('SEND',...) call always stamps sentAt as "now" — to get a real,
    // non-trivial lead time (days, not milliseconds) while keeping receivedAt inside this test's
    // own [from, to()) window, sentAt is backdated by a direct admin-connection UPDATE after the
    // real state-machine transition completes, then received at a real later-but-still-past instant.
    const { purchaseOrderId: po1, purchaseOrderLineId: line1 } = await createSentPurchaseOrder(
      organizationId,
      storeId,
      supplierId,
      supplierProductId,
      productId,
      unitId,
      '5',
      '2.00'
    );
    const po1SentAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await adminDb.update(purchaseOrders).set({ sentAt: po1SentAt }).where(eq(purchaseOrders.id, po1));
    await receiveAgainstPo(organizationId, storeId, supplierId, po1, line1, '5', new Date(po1SentAt.getTime() + 2 * 24 * 60 * 60 * 1000));

    const { purchaseOrderId: po2, purchaseOrderLineId: line2 } = await createSentPurchaseOrder(
      organizationId,
      storeId,
      supplierId,
      supplierProductId,
      productId,
      unitId,
      '5',
      '2.00'
    );
    const po2SentAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await adminDb.update(purchaseOrders).set({ sentAt: po2SentAt }).where(eq(purchaseOrders.id, po2));
    await receiveAgainstPo(organizationId, storeId, supplierId, po2, line2, '5', new Date(po2SentAt.getTime() + 4 * 24 * 60 * 60 * 1000));

    const [leadTimeActual, leadTimeVariance] = await Promise.all([
      executeMetric('lead_time_actual', { supplierId, from, to: to() }, auth(), plainCtx(organizationId)),
      executeMetric('lead_time_variance', { supplierId, from, to: to() }, auth(), plainCtx(organizationId)),
    ]);
    // (2 + 4) / 2 = 3 days.
    expect(leadTimeActual.value).toBe('3.00');
    // Population stdev of [2, 4] around mean 3 = 1.
    expect(leadTimeVariance.value).toBe('1.00');
  });

  it('lead_time_actual is unknown with no PO-linked receipts for the supplier in the period', async () => {
    const { organizationId, supplierId } = await setUpOrg();
    const result = await executeMetric('lead_time_actual', { supplierId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
  });

  it('price_stability_index computes a real coefficient of variation from real supplier_prices history', async () => {
    const { organizationId, supplierId } = await setUpOrg();
    const { supplierProductId } = await makeProduct(organizationId, supplierId);

    const priceRepo = new SupplierPriceRepository(db, organizationId);
    await priceRepo.recordNewPrice({
      id: generateId(),
      supplierProductId,
      unitPrice: '10.00',
      currency: 'USD',
      validFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    });
    await priceRepo.recordNewPrice({
      id: generateId(),
      supplierProductId,
      unitPrice: '12.00',
      currency: 'USD',
      validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const result = await executeMetric('price_stability_index', { supplierProductId }, auth(), plainCtx(organizationId));
    expect(result.value).not.toBe('unknown');
    // Prices [10, 12] -> mean 11, population stdev 1, CV = 1/11 = 0.0909.
    expect(Number(result.value)).toBeCloseTo(0.0909, 3);
  });

  it('price_stability_index is unknown with fewer than 2 recorded prices', async () => {
    const { organizationId, supplierId } = await setUpOrg();
    const { supplierProductId } = await makeProduct(organizationId, supplierId);
    const priceRepo = new SupplierPriceRepository(db, organizationId);
    await priceRepo.recordNewPrice({
      id: generateId(),
      supplierProductId,
      unitPrice: '10.00',
      currency: 'USD',
      validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const result = await executeMetric('price_stability_index', { supplierProductId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
  });

  it('executeMetric refuses a caller without purchasing:read for a supplier metric', async () => {
    const { organizationId, supplierId } = await setUpOrg();
    await expect(
      executeMetric('fill_rate', { supplierId, from, to: to() }, auth([]), plainCtx(organizationId))
    ).rejects.toThrow(/purchasing:read/);
  });
});
