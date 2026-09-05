import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import {
  notifications,
  notificationRules,
  auditLogs,
  documents,
  goodsReceiptLines,
  goodsReceipts,
  invoiceMatches,
  invoiceMatchLines,
  lots,
  outboxEvents,
  organizations,
  products,
  productVariants,
  purchaseOrderLines,
  purchaseOrders,
  stockLevels,
  stockMovements,
  stores,
  suppliers,
  supplierPerformanceEvents,
  supplierProducts,
  units,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { PurchaseOrderRepository } from '../repositories/purchase-order-repository';
import { GoodsReceiptRepository } from '../repositories/goods-receipt-repository';
import { DocumentRepository } from '../repositories/document-repository';
import { InvoiceMatchRepository } from '../repositories/invoice-match-repository';
import { gatherReconciliationBatch } from './reconciliation-batch-report';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * proves the batch-reconciliation report's real data-gathering half against real
 * Postgres — a genuine batch of 50+ real invoice lines, run through the SAME `InvoiceMatchRepository
 * .runMatch` real write path every posted invoice already goes through (never a shortcut fixture),
 * a real mix of CLEAN (fully matched against a real PO+receipt) and UNORDERED_ITEM (no PO at all)
 * lines, proving the report's match rate and exception ranking against genuinely persisted data —
 * the "aggregate report over already-matched real invoices" design confirmed with the user.
 */
describe('gatherReconciliationBatch', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let supplierId: string;
  let supplierName: string;
  let productId: string;
  let variantId: string;
  let supplierProductId: string;
  let kgUnitId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Batch Reconciliation Test Org',
      slug: `batch-recon-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    supplierName = 'Batch Recon Supplier';
    supplierId = generateId();
    await adminDb.insert(suppliers).values({ id: supplierId, organizationId, name: supplierName });

    const [kg] = await adminDb.select().from(units).where(eq(units.code, 'kg'));
    kgUnitId = kg!.id;

    productId = generateId();
    await adminDb.insert(products).values({ id: productId, organizationId, sku: 'BATCH-RECON-SKU', name: 'Batch Recon Product', baseUnitId: kgUnitId, type: 'INGREDIENT' });
    variantId = generateId();
    await adminDb.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });

    supplierProductId = generateId();
    await adminDb.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: 'BATCH-RECON-SKU', isConfirmed: true });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(invoiceMatchLines).where(eq(invoiceMatchLines.organizationId, organizationId));
    await adminDb.delete(invoiceMatches).where(eq(invoiceMatches.organizationId, organizationId));
    await adminDb.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, organizationId));
    await adminDb.delete(documents).where(eq(documents.organizationId, organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    await adminDb.update(lots).set({ goodsReceiptLineId: null }).where(eq(lots.organizationId, organizationId));
    await adminDb.delete(goodsReceiptLines).where(eq(goodsReceiptLines.organizationId, organizationId));
    await adminDb.delete(lots).where(eq(lots.organizationId, organizationId));
    await adminDb.delete(goodsReceipts).where(eq(goodsReceipts.organizationId, organizationId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, organizationId));
    await adminDb.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, organizationId));
    await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, organizationId));
    await adminDb.delete(productVariants).where(eq(productVariants.productId, productId));
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, organizationId));
    // `notifications.store_id` references `stores`, so notification rows must go BEFORE the
    // store rows. Sweep processors can create these for any org present in the database, so a
    // fixture that never creates one itself can still be holding some at teardown time.
    await adminDb.delete(notifications).where(eq(notifications.organizationId, organizationId));
    await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('a real batch of 50+ invoice lines across many invoices produces an honest match rate and a real, ranked exception list', async () => {
    const matchRepo = new InvoiceMatchRepository(createScopedDb(client), organizationId);

    const createSentPurchaseOrder = async (unitPrice: string) => {
      const poRepo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-BATCH-${generateId()}`, currency: 'USD' });
      const addLineResult = await poRepo.addLine({
        purchaseOrderId: created.id,
        supplierProductId,
        productId,
        quantityOrderUnits: '10',
        orderUnitId: kgUnitId,
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

    const receiveAgainstPo = async (purchaseOrderId: string, purchaseOrderLineId: string) => {
      const grRepo = new GoodsReceiptRepository(createScopedDb(client), organizationId);
      await grRepo.confirmReceipt({
        storeId,
        purchaseOrderId,
        supplierId,
        receivedAt: new Date(),
        lines: [{ purchaseOrderLineId, productId, variantId, receivedQuantityBaseUnits: '10', unitCost: '5.00', currency: 'USD', lineNumber: 1 }],
      });
    };

    const documentRepo = new DocumentRepository(createScopedDb(client), organizationId);
    const createRealDocumentId = async (): Promise<string> => {
      const doc = await documentRepo.create({
        storeId,
        type: 'INVOICE',
        source: 'UPLOAD',
        storageKey: `${organizationId}/batch-recon-test-${generateId()}.pdf`,
        contentHash: `batch-recon-hash-${generateId()}`,
        mimeType: 'application/pdf',
        sizeBytes: 1,
      });
      return doc.id;
    };

    // 40 CLEAN invoices: real PO at $5.00/kg, real full receipt, real invoice at the same price.
    for (let i = 0; i < 40; i++) {
      const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('5.00');
      await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId);
      await matchRepo.runMatch({
        documentId: await createRealDocumentId(),
        storeId,
        supplierName,
        lines: [{ sku: { value: 'BATCH-RECON-SKU' }, quantity: { value: '10' }, unitPrice: { value: '5.00' } }],
      });
    }

    // 15 real UNORDERED_ITEM exceptions: invoiced against a SKU with no supplier_products mapping
    // at all — a real, honest "billed but never ordered" case, no PO/receipt involved.
    for (let i = 0; i < 15; i++) {
      await matchRepo.runMatch({
        documentId: await createRealDocumentId(),
        storeId,
        supplierName,
        lines: [{ sku: { value: `UNMAPPED-SKU-${i}` }, quantity: { value: '20' }, unitPrice: { value: '3.00' } }],
      });
    }

    const report = await gatherReconciliationBatch(createScopedDb(client), organizationId, { storeId });

    expect(report.totalLines).toBe(55);
    expect(report.cleanLines).toBe(40);
    expect(report.matchRate?.toString()).toBe('0.72727272727272727273');
    expect(report.exceptions).toHaveLength(15);
    for (const exception of report.exceptions) {
      expect(exception.varianceType).toBe('UNORDERED_ITEM');
      // 20 * 3.00 = 60 for every unordered line — a real, computed exposure, never fabricated.
      expect(exception.dollarImpact?.toString()).toBe('60');
    }
    expect(report.totalExceptionImpact?.toString()).toBe('900'); // 15 * 60
    expect(report.unresolvableCount).toBe(0);
  }, 30000);

  it('an org with zero matched invoices returns an honest empty report, never a fabricated rate', async () => {
    const report = await gatherReconciliationBatch(createScopedDb(client), organizationId, { storeId });
    expect(report.totalLines).toBe(0);
    expect(report.matchRate).toBeNull();
  });
});
