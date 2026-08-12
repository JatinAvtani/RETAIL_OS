import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import {
  auditLogs,
  goodsReceiptLines,
  goodsReceipts,
  lots,
  outboxEvents,
  organizations,
  products,
  purchaseOrderLines,
  purchaseOrders,
  stockLevels,
  stockMovements,
  stores,
  suppliers,
  supplierProducts,
  units,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { PurchaseOrderRepository } from './purchase-order-repository';
import { GoodsReceiptRepository, UnknownReceiptCostError } from './goods-receipt-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('GoodsReceiptRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let supplierId: string;
  let productId: string;
  let variantId: string;
  let supplierProductId: string;
  let kgUnitId: string;

  const createSentPurchaseOrder = async (quantityOrderUnits: string, unitPrice: string) => {
    const poRepo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-GR-${generateId()}`, currency: 'USD' });
    const addLineResult = await poRepo.addLine({
      purchaseOrderId: created.id,
      supplierProductId,
      productId,
      quantityOrderUnits,
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

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Goods Receipt Test Org',
      slug: `gr-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    supplierId = generateId();
    await adminDb.insert(suppliers).values({ id: supplierId, organizationId, name: 'Test Supplier' });

    const [kg] = await adminDb.select().from(units).where(eq(units.code, 'kg'));
    kgUnitId = kg!.id;

    productId = generateId();
    await adminDb.insert(products).values({
      id: productId,
      organizationId,
      sku: 'GR-TEST-SKU',
      name: 'GR Test Product',
      baseUnitId: kgUnitId,
      type: 'INGREDIENT',
    });
    variantId = generateId();
    await adminDb.insert(schema.productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });

    supplierProductId = generateId();
    await adminDb.insert(supplierProducts).values({
      id: supplierProductId,
      organizationId,
      supplierId,
      productId,
      supplierSku: 'SUP-SKU-GR-TEST',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    // A genuine MUTUAL FK cycle: lots.goodsReceiptLineId -> goods_receipt_lines.id AND
    // goods_receipt_lines.lot_id -> lots.id. Neither table can be deleted first — breaking the
    // cycle requires nulling one side's FK column before deleting either table, same as any
    // circular-reference teardown.
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, organizationId));
    await adminDb.update(lots).set({ goodsReceiptLineId: null }).where(eq(lots.organizationId, organizationId));
    await adminDb.delete(goodsReceiptLines).where(eq(goodsReceiptLines.organizationId, organizationId));
    await adminDb.delete(lots).where(eq(lots.organizationId, organizationId));
    await adminDb.delete(goodsReceipts).where(eq(goodsReceipts.organizationId, organizationId));
    await adminDb.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, organizationId));
    await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, organizationId));
    await adminDb.delete(schema.productVariants).where(eq(schema.productVariants.productId, productId));
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('confirmReceipt against a full PO quantity creates a real lot + RECEIPT movement and transitions the PO to RECEIVED', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '5.00');
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

    const result = await repo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [
        {
          purchaseOrderLineId,
          productId,
          variantId,
          receivedQuantityBaseUnits: '10',
          lineNumber: 1,
        },
      ],
    });

    expect(result.purchaseOrderNewStatus).toBe('RECEIVED');

    const adminDb = drizzle(adminClient, { schema });
    const [receiptLine] = await adminDb.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, result.goodsReceiptId));
    expect(receiptLine).toBeDefined();
    expect(receiptLine!.lotId).not.toBeNull();
    expect(receiptLine!.unitCost).toBe('5.0000'); // inherited from the PO line's unitPrice

    const [lot] = await adminDb.select().from(lots).where(eq(lots.id, receiptLine!.lotId!));
    expect(lot!.initialQuantity).toBe('10.000000');
    expect(lot!.unitCost).toBe('5.0000');
    expect(lot!.goodsReceiptLineId).toBe(receiptLine!.id);

    const movements = await adminDb.select().from(stockMovements).where(eq(stockMovements.sourceId, result.goodsReceiptId));
    expect(movements).toHaveLength(1);
    expect(movements[0]!.movementType).toBe('RECEIPT');
    expect(movements[0]!.quantity).toBe('10.000000');

    const [poLine] = await adminDb.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, purchaseOrderLineId));
    expect(poLine!.receivedQuantityBaseUnits).toBe('10.000000');

    const [po] = await adminDb.select().from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId));
    expect(po!.status).toBe('RECEIVED');
  });

  it('a receipt line supplying ONLY purchaseOrderLineId (no explicit productId/variantId) resolves both server-side from the real PO line', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('7', '3.00');
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

    const result = await repo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '7', lineNumber: 1 }],
    });

    expect(result.purchaseOrderNewStatus).toBe('RECEIVED');
    const adminDb = drizzle(adminClient, { schema });
    const [receiptLine] = await adminDb.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, result.goodsReceiptId));
    expect(receiptLine!.productId).toBe(productId);
    expect(receiptLine!.variantId).toBe(variantId); // resolved via isDefault, since the PO line itself never recorded a variantId
    expect(receiptLine!.unitCost).toBe('3.0000');
  });

  it('a partial receipt (less than ordered) transitions the PO to PARTIALLY_RECEIVED, and a second receipt completing it reaches RECEIVED', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '5.00');
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

    const first = await repo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ purchaseOrderLineId, productId, variantId, receivedQuantityBaseUnits: '6', lineNumber: 1 }],
    });
    expect(first.purchaseOrderNewStatus).toBe('PARTIALLY_RECEIVED');

    const second = await repo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ purchaseOrderLineId, productId, variantId, receivedQuantityBaseUnits: '4', lineNumber: 1 }],
    });
    expect(second.purchaseOrderNewStatus).toBe('RECEIVED');

    const adminDb = drizzle(adminClient, { schema });
    const [poLine] = await adminDb.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, purchaseOrderLineId));
    expect(poLine!.receivedQuantityBaseUnits).toBe('10.000000'); // 6 + 4, accumulated across two receipts

    const receipts = await adminDb.select().from(goodsReceipts).where(eq(goodsReceipts.purchaseOrderId, purchaseOrderId));
    expect(receipts).toHaveLength(2); // two real, separate receipt rows
  });

  it('a receipt exceeding the ordered quantity is rejected by the real database CHECK constraint (purchase_order_lines_received_within_ordered)', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('5', '5.00');
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

    await expect(
      repo.confirmReceipt({
        storeId,
        purchaseOrderId,
        supplierId,
        receivedAt: new Date(),
        lines: [{ purchaseOrderLineId, productId, variantId, receivedQuantityBaseUnits: '99', lineNumber: 1 }],
      })
    ).rejects.toThrow();
  });

  it('a discrepancy code is recorded on the receipt line', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '5.00');
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

    const result = await repo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [
        {
          purchaseOrderLineId,
          productId,
          variantId,
          receivedQuantityBaseUnits: '8',
          discrepancyCode: 'SHORT',
          discrepancyNotes: '2kg missing from the delivery',
          lineNumber: 1,
        },
      ],
    });

    const adminDb = drizzle(adminClient, { schema });
    const [receiptLine] = await adminDb.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, result.goodsReceiptId));
    expect(receiptLine!.discrepancyCode).toBe('SHORT');
    expect(receiptLine!.discrepancyNotes).toBe('2kg missing from the delivery');
  });

  it('appendPhotoKey adds a photo key to a real line, never overwriting a prior one (008-08)', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '5.00');
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

    const result = await repo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ purchaseOrderLineId, productId, variantId, receivedQuantityBaseUnits: '8', discrepancyCode: 'DAMAGED', lineNumber: 1 }],
    });
    const [line] = await repo.findLines(result.goodsReceiptId);
    expect(line!.photoObjectKeys).toBeNull();

    await repo.appendPhotoKey(line!.id, 'org/x/goods-receipt-lines/y/photos/1.jpg');
    const afterFirst = await repo.findLineById(line!.id);
    expect(afterFirst!.photoObjectKeys).toEqual(['org/x/goods-receipt-lines/y/photos/1.jpg']);

    await repo.appendPhotoKey(line!.id, 'org/x/goods-receipt-lines/y/photos/2.jpg');
    const afterSecond = await repo.findLineById(line!.id);
    expect(afterSecond!.photoObjectKeys).toEqual([
      'org/x/goods-receipt-lines/y/photos/1.jpg',
      'org/x/goods-receipt-lines/y/photos/2.jpg',
    ]);
  });

  it('findLineById returns null for a line that does not exist', async () => {
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);
    const line = await repo.findLineById(generateId());
    expect(line).toBeNull();
  });

  it('a receipt line with no purchase order line AND no explicit unitCost throws UnknownReceiptCostError, never a guessed 0 (I7)', async () => {
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

    await expect(
      repo.confirmReceipt({
        storeId,
        supplierId,
        receivedAt: new Date(),
        lines: [{ productId, variantId, receivedQuantityBaseUnits: '3', lineNumber: 1 }],
      })
    ).rejects.toThrow(UnknownReceiptCostError);
  });

  describe('receipt without a PO — walk-in/emergency purchases (008-09)', () => {
    it('confirmReceipt with no purchaseOrderId creates a real lot + RECEIPT movement using the explicit productId/variantId/unitCost, and reports no PO status change', async () => {
      const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

      const result = await repo.confirmReceipt({
        storeId,
        supplierId,
        receivedAt: new Date(),
        lines: [{ productId, variantId, receivedQuantityBaseUnits: '6', unitCost: '3.50', currency: 'USD', lineNumber: 1 }],
      });

      expect(result.purchaseOrderNewStatus).toBeNull();

      const adminDb = drizzle(adminClient, { schema });
      const [receipt] = await adminDb.select().from(goodsReceipts).where(eq(goodsReceipts.id, result.goodsReceiptId));
      expect(receipt!.purchaseOrderId).toBeNull();

      const [receiptLine] = await adminDb.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, result.goodsReceiptId));
      expect(receiptLine!.purchaseOrderLineId).toBeNull();
      expect(receiptLine!.unitCost).toBe('3.5000');
      expect(receiptLine!.lotId).not.toBeNull();

      const [lot] = await adminDb.select().from(lots).where(eq(lots.id, receiptLine!.lotId!));
      expect(lot!.initialQuantity).toBe('6.000000');
      expect(lot!.unitCost).toBe('3.5000');
      expect(lot!.status).toBe('ACTIVE');

      const movements = await adminDb.select().from(stockMovements).where(eq(stockMovements.sourceId, result.goodsReceiptId));
      expect(movements).toHaveLength(1);
      expect(movements[0]!.movementType).toBe('RECEIPT');
      expect(movements[0]!.quantity).toBe('6.000000');
    });

    it('a walk-in receipt line falls back to the product default variant when variantId is also omitted', async () => {
      const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

      const result = await repo.confirmReceipt({
        storeId,
        supplierId,
        receivedAt: new Date(),
        lines: [{ productId, receivedQuantityBaseUnits: '2', unitCost: '9.00', lineNumber: 1 }],
      });

      const adminDb = drizzle(adminClient, { schema });
      const [receiptLine] = await adminDb.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.goodsReceiptId, result.goodsReceiptId));
      expect(receiptLine!.variantId).toBe(variantId); // resolved via isDefault
    });

    it('a walk-in receipt writes a real receipt.recorded outbox event with purchaseOrderId null', async () => {
      const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

      const result = await repo.confirmReceipt({
        storeId,
        supplierId,
        receivedAt: new Date(),
        lines: [{ productId, variantId, receivedQuantityBaseUnits: '1', unitCost: '1.00', lineNumber: 1 }],
      });

      const adminDb = drizzle(adminClient, { schema });
      const events = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, result.goodsReceiptId));
      const receiptEvent = events.find((e) => e.eventType === 'receipt.recorded');
      expect(receiptEvent).toBeDefined();
      expect((receiptEvent!.payload as { purchaseOrderId: string | null }).purchaseOrderId).toBeNull();
    });
  });

  it('confirmReceipt writes a real receipt.recorded outbox event', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '5.00');
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

    const result = await repo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ purchaseOrderLineId, productId, variantId, receivedQuantityBaseUnits: '10', lineNumber: 1 }],
    });

    const adminDb = drizzle(adminClient, { schema });
    const events = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, result.goodsReceiptId));
    expect(events.some((e) => e.eventType === 'receipt.recorded')).toBe(true);

    const poEvents = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, purchaseOrderId));
    expect(poEvents.some((e) => e.eventType === 'po.received')).toBe(true);
  });

  it('findById/findLines return the real receipt and its lines', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '5.00');
    const repo = new GoodsReceiptRepository(createScopedDb(client), organizationId);

    const result = await repo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ purchaseOrderLineId, productId, variantId, receivedQuantityBaseUnits: '10', lineNumber: 1 }],
    });

    const receipt = await repo.findById(result.goodsReceiptId);
    expect(receipt?.purchaseOrderId).toBe(purchaseOrderId);

    const lines = await repo.findLines(result.goodsReceiptId);
    expect(lines).toHaveLength(1);
  });

  describe('cross-tenant isolation (I4)', () => {
    let fixture: TwoTenantFixture;

    afterEach(async () => {
      await fixture?.cleanup();
    });

    it('a goods receipt created under tenant A is invisible to tenant B, even by direct id', async () => {
      fixture = await setUpTwoTenants();
      const supplierIdA = generateId();
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.insert(suppliers).values({ id: supplierIdA, organizationId: fixture.tenantA.organizationId, name: 'Tenant A Supplier' });

      const productIdA = generateId();
      await adminDb.insert(products).values({ id: productIdA, organizationId: fixture.tenantA.organizationId, sku: `GR-CROSS-${productIdA}`, name: 'Tenant A Product', baseUnitId: kgUnitId, type: 'INGREDIENT' });
      const variantIdA = generateId();
      await adminDb.insert(schema.productVariants).values({ id: variantIdA, productId: productIdA, name: 'Default', isDefault: true });

      const repoA = new GoodsReceiptRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const repoB = new GoodsReceiptRepository(createScopedDb(client), fixture.tenantB.organizationId);

      const result = await repoA.confirmReceipt({
        storeId: fixture.tenantA.storeId,
        supplierId: supplierIdA,
        receivedAt: new Date(),
        lines: [{ productId: productIdA, variantId: variantIdA, receivedQuantityBaseUnits: '5', unitCost: '2.00', currency: 'USD', lineNumber: 1 }],
      });

      const fromB = await repoB.findById(result.goodsReceiptId);
      expect(fromB).toBeNull();

      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, fixture.tenantA.organizationId));
      await adminDb.update(lots).set({ goodsReceiptLineId: null }).where(eq(lots.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(goodsReceiptLines).where(eq(goodsReceiptLines.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(lots).where(eq(lots.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(goodsReceipts).where(eq(goodsReceipts.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(schema.productVariants).where(eq(schema.productVariants.productId, productIdA));
      await adminDb.delete(products).where(eq(products.id, productIdA));
      await adminDb.delete(suppliers).where(eq(suppliers.id, supplierIdA));
    });
  });
});
