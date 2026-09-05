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
import { GoodsReceiptRepository } from './goods-receipt-repository';
import { DocumentRepository } from './document-repository';
import { InvoiceMatchRepository, UnresolvableInvoiceSupplierError } from './invoice-match-repository';
import { SupplierPerformanceEventRepository } from './supplier-performance-event-repository';
import { supplierPerformanceEvents } from '../schema/index';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('InvoiceMatchRepository', () => {
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

  const createSentPurchaseOrder = async (
    quantityOrderUnits: string,
    unitPrice: string,
    conversionToBase = '1'
  ) => {
    const poRepo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-IM-${generateId()}`, currency: 'USD' });
    const addLineResult = await poRepo.addLine({
      purchaseOrderId: created.id,
      supplierProductId,
      productId,
      quantityOrderUnits,
      orderUnitId: kgUnitId,
      conversionToBase,
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

  const receiveAgainstPo = async (purchaseOrderId: string, purchaseOrderLineId: string, receivedQuantityBaseUnits: string) => {
    const grRepo = new GoodsReceiptRepository(createScopedDb(client), organizationId);
    return grRepo.confirmReceipt({
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits, lineNumber: 1 }],
    });
  };

  const createPostedInvoiceDocument = async () => {
    const documentRepo = new DocumentRepository(createScopedDb(client), organizationId);
    const doc = await documentRepo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/invoice-match-test-${generateId()}.pdf`,
      contentHash: `invoice-match-hash-${generateId()}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    return doc.id;
  };

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Invoice Match Test Org',
      slug: `invoice-match-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    supplierId = generateId();
    supplierName = `Invoice Match Supplier ${generateId()}`;
    await adminDb.insert(suppliers).values({ id: supplierId, organizationId, name: supplierName });

    const [kg] = await adminDb.select().from(units).where(eq(units.code, 'kg'));
    kgUnitId = kg!.id;

    productId = generateId();
    await adminDb.insert(products).values({
      id: productId,
      organizationId,
      sku: 'IM-TEST-SKU',
      name: 'Invoice Match Test Product',
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
      supplierSku: 'SUP-SKU-IM-TEST',
      isConfirmed: true,
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, organizationId));
    await adminDb.delete(invoiceMatchLines).where(eq(invoiceMatchLines.organizationId, organizationId));
    await adminDb.delete(invoiceMatches).where(eq(invoiceMatches.organizationId, organizationId));
    await adminDb.delete(documents).where(eq(documents.organizationId, organizationId));
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

  it('matches a clean invoice line against a fully received PO line — CLEAN, NONE severity', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '4.50');
    await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '10');
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
    });

    expect(result.highestSeverity).toBe('NONE');
    expect(result.purchaseOrderId).toBe(purchaseOrderId);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.varianceType).toBe('CLEAN');

    const adminDb = drizzle(adminClient, { schema });
    const [matchRow] = await adminDb.select().from(invoiceMatches).where(eq(invoiceMatches.documentId, documentId));
    expect(matchRow?.highestSeverity).toBe('NONE');
    expect(matchRow?.purchaseOrderId).toBe(purchaseOrderId);

    const lineRows = await adminDb.select().from(invoiceMatchLines).where(eq(invoiceMatchLines.invoiceMatchId, matchRow!.id));
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0]?.varianceType).toBe('CLEAN');
    expect(lineRows[0]?.productId).toBe(productId);

    // The PO/receipt lifecycle that set up this test's fixture (create/submit/approve/send/receive)
    // emits its own real outbox events in the SAME org — this only asserts the match's own event
    // genuinely landed, not that it was the only event in the org.
    const events = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    expect(events.map((e) => e.eventType)).toContain('match.variance_detected');
  });

  it('findLines returns a real product name for a matched line, and null (never a fabricated name) for an unresolved one', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '4.50');
    await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '10');
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [
        { sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }, // resolves to the real fixture product
        { sku: { value: 'NEVER-MAPPED-FOR-FINDLINES-TEST' }, quantity: { value: '1' }, unitPrice: { value: '1.00' } }, // UNORDERED_ITEM — no product resolves
      ],
    });

    const lines = await repo.findLines(result.id);
    expect(lines).toHaveLength(2);
    const matched = lines.find((l) => l.productId === productId);
    expect(matched?.productName).toBe('Invoice Match Test Product');
    const unmatched = lines.find((l) => l.productId === null);
    expect(unmatched?.productName).toBeNull();
  });

  it('compares invoice packs with received base units through the frozen PO conversion', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder(
      '3',
      '1785.40',
      '10000'
    );
    await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '30000');
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [
        {
          sku: { value: 'SUP-SKU-IM-TEST' },
          quantity: { value: '3' },
          unitPrice: { value: '1785.40' },
        },
      ],
    });

    expect(result.highestSeverity).toBe('NONE');
    expect(result.lines[0]?.varianceType).toBe('CLEAN');

    const adminDb = drizzle(adminClient, { schema });
    const [matchRow] = await adminDb
      .select()
      .from(invoiceMatches)
      .where(eq(invoiceMatches.documentId, documentId));
    const [lineRow] = await adminDb
      .select()
      .from(invoiceMatchLines)
      .where(eq(invoiceMatchLines.invoiceMatchId, matchRow!.id));
    expect(lineRow?.receivedQuantity).toBe('3.000000');
    expect(lineRow?.quantityVariance).toBe('0.000000');
  });

  it('degrades quantity comparison to unknown rather than dividing by zero when a supplier-product conversion factor is invalid', async () => {
    // `supplier_products.conversion_to_base` has no CHECK constraint (unlike a PO line's ordered/
    // received relationship, which the database itself guards) — a zero value here is realistic
    // legacy/bad data, not something the schema already prevents. This is the walk-in-receipt path
    // (no PO line at all), which falls back to this exact column per the fix's own comment.
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.update(supplierProducts).set({ conversionToBase: '0' }).where(eq(supplierProducts.id, supplierProductId));

    const grRepo = new GoodsReceiptRepository(createScopedDb(client), organizationId);
    await grRepo.confirmReceipt({
      storeId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ productId, variantId, receivedQuantityBaseUnits: '5', unitCost: '6.00', currency: 'USD', lineNumber: 1 }],
    });
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '5' }, unitPrice: { value: '6.00' } }],
    });

    // A zero conversion factor makes "received quantity in order units" unanswerable — this must
    // never throw (dividing by zero) and must never silently misreport a quantity variance (I7):
    // the line still resolves on price alone, with quantity treated as unknown, not flagged.
    expect(result.highestSeverity).toBe('NONE');
    expect(result.lines[0]?.varianceType).toBe('CLEAN');

    const [matchRow] = await adminDb
      .select()
      .from(invoiceMatches)
      .where(eq(invoiceMatches.documentId, documentId));
    const [lineRow] = await adminDb
      .select()
      .from(invoiceMatchLines)
      .where(eq(invoiceMatchLines.invoiceMatchId, matchRow!.id));
    expect(lineRow?.receivedQuantity).toBeNull();
    expect(lineRow?.quantityVariance).toBeNull();

    // Restore the fixture's real default (unset — the `beforeAll` insert never sets this column),
    // so later tests in this file see the same starting state they always have.
    await adminDb.update(supplierProducts).set({ conversionToBase: null }).where(eq(supplierProducts.id, supplierProductId));
  });

  it('flags a real price variance beyond tolerance between the invoice and the PO', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '50.00');
    await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '10');
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      // Invoiced at $100 vs PO's $50 — well beyond both the $5 absolute and 2% relative tolerance.
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '100.00' } }],
    });

    expect(result.highestSeverity).toBe('MEDIUM');
    expect(result.lines[0]?.varianceType).toBe('PRICE_VARIANCE');

    const adminDb = drizzle(adminClient, { schema });
    const [matchRow] = await adminDb.select().from(invoiceMatches).where(eq(invoiceMatches.documentId, documentId));
    const lineRows = await adminDb.select().from(invoiceMatchLines).where(eq(invoiceMatchLines.invoiceMatchId, matchRow!.id));
    expect(lineRows[0]?.priceVariance).toBe('50.0000');
    expect(lineRows[0]?.poUnitPrice).toBe('50.0000');
    expect(lineRows[0]?.invoiceUnitPrice).toBe('100.0000');
  });

  describe('supplier performance event emission', () => {
    it('a real price variance emits a real PRICE_VARIANCE event AND an INVOICE_ERROR event for the whole invoice', async () => {
      const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '50.00');
      await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '10');
      const documentId = await createPostedInvoiceDocument();

      const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
      await repo.runMatch({
        documentId,
        storeId,
        supplierName,
        lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '100.00' } }],
      });

      const eventRepo = new SupplierPerformanceEventRepository(createScopedDb(client), organizationId);
      const events = await eventRepo.findForSupplierSince(supplierId, new Date(Date.now() - 60_000));
      const types = events.map((e) => e.eventType).sort();
      // FILL_COMPLETE/DELIVERY_* also fire from the receiveAgainstPo() call above this test makes —
      // this asserts the two NEW event types this test actually cares about are both present.
      expect(types).toContain('PRICE_VARIANCE');
      expect(types).toContain('INVOICE_ERROR');
      expect(types).not.toContain('INVOICE_CLEAN');

      const priceEvent = events.find((e) => e.eventType === 'PRICE_VARIANCE')!;
      // The event's real column is numeric(19,6) — Postgres pads the 4dp value this repository
      // writes ('50.0000') to the column's own real scale on storage; the ACTUAL persisted value,
      // not a hand-guessed one, is what this asserts (memory: re-derive precision from real output).
      expect(priceEvent.expectedValue).toBe('50.000000');
      expect(priceEvent.actualValue).toBe('100.000000');
      expect(priceEvent.variance).toBe('50.000000');
      expect(priceEvent.documentId).toBe(documentId);
      expect(priceEvent.productId).toBe(productId);
    });

    it('a clean match emits INVOICE_CLEAN and no PRICE_VARIANCE event at all', async () => {
      const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '4.50');
      await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '10');
      const documentId = await createPostedInvoiceDocument();

      const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
      await repo.runMatch({
        documentId,
        storeId,
        supplierName,
        lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
      });

      const eventRepo = new SupplierPerformanceEventRepository(createScopedDb(client), organizationId);
      const events = await eventRepo.findForSupplierSince(supplierId, new Date(Date.now() - 60_000));
      const types = events.map((e) => e.eventType);
      expect(types).toContain('INVOICE_CLEAN');
      expect(types).not.toContain('INVOICE_ERROR');
      expect(types).not.toContain('PRICE_VARIANCE');
    });

    it('an UNORDERED_ITEM line (no PO/receipt match at all) emits no PRICE_VARIANCE event — there is no real poUnitPrice to compare against', async () => {
      const documentId = await createPostedInvoiceDocument();
      const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
      await repo.runMatch({
        documentId,
        storeId,
        supplierName,
        lines: [{ sku: { value: 'NO-SUCH-SKU' }, quantity: { value: '3' }, unitPrice: { value: '9.00' } }],
      });

      const eventRepo = new SupplierPerformanceEventRepository(createScopedDb(client), organizationId);
      const events = await eventRepo.findForSupplierSince(supplierId, new Date(Date.now() - 60_000));
      expect(events.some((e) => e.eventType === 'PRICE_VARIANCE')).toBe(false);
      // The whole-invoice INVOICE_ERROR event still fires — an unordered item is a real error, just not a price one.
      expect(events.some((e) => e.eventType === 'INVOICE_ERROR')).toBe(true);
    });
  });

  it('a widened org-level price tolerance turns a would-be variance into CLEAN — ', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '50.00');
    await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '10');
    const documentId = await createPostedInvoiceDocument();

    const adminDb = drizzle(adminClient, { schema });
    // A real org-level override: 100% price tolerance — the same $100-vs-$50 line that the
    // default-tolerance test above correctly flags PRICE_VARIANCE must now be CLEAN.
    await adminDb.update(organizations).set({ matchPriceTolerancePercent: '1.0000' }).where(eq(organizations.id, organizationId));

    try {
      const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
      const result = await repo.runMatch({
        documentId,
        storeId,
        supplierName,
        lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '100.00' } }],
      });

      expect(result.lines[0]?.varianceType).toBe('CLEAN');
      expect(result.highestSeverity).toBe('NONE');
    } finally {
      await adminDb.update(organizations).set({ matchPriceTolerancePercent: null }).where(eq(organizations.id, organizationId));
    }
  });

  it('a partial org override (price only) still uses the real default for quantity tolerance — ', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '4.50');
    await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '8'); // partial: only 8 arrived
    const documentId = await createPostedInvoiceDocument();

    const adminDb = drizzle(adminClient, { schema });
    // Only the price tolerance is overridden — quantity tolerance is left null (must fall back to
    // DEFAULT_MATCH_TOLERANCES.quantityTolerancePercent, not silently become 0/unlimited).
    await adminDb.update(organizations).set({ matchPriceTolerancePercent: '0.5000' }).where(eq(organizations.id, organizationId));

    try {
      const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
      const result = await repo.runMatch({
        documentId,
        storeId,
        supplierName,
        lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
      });

      // Price matches exactly (no price variance either way), but the real default 2% quantity
      // tolerance still correctly flags invoicing for 10 when only 8 arrived.
      expect(result.lines[0]?.varianceType).toBe('QUANTITY_VARIANCE');
    } finally {
      await adminDb.update(organizations).set({ matchPriceTolerancePercent: null }).where(eq(organizations.id, organizationId));
    }
  });

  it('flags a real quantity variance between the invoice and the received quantity', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '4.50');
    await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '8'); // partial receipt: only 8 arrived
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      // Billed for the full 10 even though only 8 were received.
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
    });

    expect(result.lines[0]?.varianceType).toBe('QUANTITY_VARIANCE');

    const adminDb = drizzle(adminClient, { schema });
    const [matchRow] = await adminDb.select().from(invoiceMatches).where(eq(invoiceMatches.documentId, documentId));
    const lineRows = await adminDb.select().from(invoiceMatchLines).where(eq(invoiceMatchLines.invoiceMatchId, matchRow!.id));
    expect(lineRows[0]?.quantityVariance).toBe('2.000000');
    expect(lineRows[0]?.receivedQuantity).toBe('8.000000');
  });

  it('flags INVOICED_NOT_RECEIVED at HIGH severity when a PO line exists but nothing was ever received against it', async () => {
    const { purchaseOrderId } = await createSentPurchaseOrder('10', '4.50');
    // Deliberately no receiveAgainstPo call — nothing was ever received.
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
    });

    expect(result.purchaseOrderId).toBe(purchaseOrderId);
    expect(result.highestSeverity).toBe('HIGH');
    expect(result.lines[0]?.varianceType).toBe('INVOICED_NOT_RECEIVED');
  });

  it('flags UNORDERED_ITEM for an invoice line whose SKU has no confirmed supplier-product mapping at all', async () => {
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'NEVER-MAPPED-SKU-IM' }, quantity: { value: '3' }, unitPrice: { value: '9.00' } }],
    });

    expect(result.purchaseOrderId).toBeNull();
    expect(result.highestSeverity).toBe('MEDIUM');
    expect(result.lines[0]?.varianceType).toBe('UNORDERED_ITEM');

    const adminDb = drizzle(adminClient, { schema });
    const [matchRow] = await adminDb.select().from(invoiceMatches).where(eq(invoiceMatches.documentId, documentId));
    const lineRows = await adminDb.select().from(invoiceMatchLines).where(eq(invoiceMatchLines.invoiceMatchId, matchRow!.id));
    expect(lineRows[0]?.productId).toBeNull();
    expect(lineRows[0]?.purchaseOrderLineId).toBeNull();
    expect(lineRows[0]?.goodsReceiptLineId).toBeNull();
  });

  it('matches a walk-in receipt (no PO at all) purely by product/supplier — integration', async () => {
    const grRepo = new GoodsReceiptRepository(createScopedDb(client), organizationId);
    await grRepo.confirmReceipt({
      storeId,
      supplierId,
      receivedAt: new Date(),
      lines: [{ productId, variantId, receivedQuantityBaseUnits: '5', unitCost: '6.00', currency: 'USD', lineNumber: 1 }],
    });
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '5' }, unitPrice: { value: '6.00' } }],
    });

    // No PO involved anywhere in this walk-in path — purchaseOrderId must stay null, never guessed.
    expect(result.purchaseOrderId).toBeNull();
    expect(result.lines[0]?.varianceType).toBe('CLEAN');
  });

  it('rejects an unparseable invoice line as UNORDERED_ITEM, never a fabricated CLEAN or a guessed number — I7', async () => {
    const documentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: null }, unitPrice: { value: '4.50' } }],
    });

    expect(result.lines[0]?.varianceType).toBe('UNORDERED_ITEM');

    const adminDb = drizzle(adminClient, { schema });
    const [matchRow] = await adminDb.select().from(invoiceMatches).where(eq(invoiceMatches.documentId, documentId));
    const lineRows = await adminDb.select().from(invoiceMatchLines).where(eq(invoiceMatchLines.invoiceMatchId, matchRow!.id));
    expect(lineRows[0]?.invoiceQuantity).toBeNull();
    expect(lineRows[0]?.priceVariance).toBeNull();
  });

  it('a real, previously matched document cannot be matched a second time — the unique document_id constraint', async () => {
    const documentId = await createPostedInvoiceDocument();
    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '1' }, unitPrice: { value: '4.50' } }],
    });

    await expect(
      repo.runMatch({
        documentId,
        storeId,
        supplierName,
        lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '1' }, unitPrice: { value: '4.50' } }],
      })
    ).rejects.toThrow();
  });

  it('throws UnresolvableInvoiceSupplierError rather than guessing a supplier when the extracted supplier name matches no real supplier and this org has none at all to fall back to', async () => {
    // A dedicated, empty org — no suppliers exist in it at all, so the fallback lookup genuinely finds nothing.
    const adminDb = drizzle(adminClient, { schema });
    const emptyOrgId = generateId();
    await adminDb.insert(organizations).values({ id: emptyOrgId, name: 'Empty Org', slug: `empty-org-${emptyOrgId}`, baseCurrency: 'USD' });
    const emptyStoreId = generateId();
    await adminDb.insert(stores).values({ id: emptyStoreId, organizationId: emptyOrgId, name: 'Empty Store', timezone: 'UTC' });
    const documentRepo = new DocumentRepository(createScopedDb(client), emptyOrgId);
    const doc = await documentRepo.create({
      storeId: emptyStoreId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${emptyOrgId}/empty-org-invoice.pdf`,
      contentHash: `empty-org-hash-${generateId()}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    const repo = new InvoiceMatchRepository(createScopedDb(client), emptyOrgId);
    await expect(
      repo.runMatch({
        documentId: doc.id,
        storeId: emptyStoreId,
        supplierName: 'Some Unresolvable Supplier Name',
        lines: [{ sku: { value: 'X' }, quantity: { value: '1' }, unitPrice: { value: '1.00' } }],
      })
    ).rejects.toThrow(UnresolvableInvoiceSupplierError);

    await adminDb.delete(documents).where(eq(documents.organizationId, emptyOrgId));
    // `notifications.store_id` references `stores`, so notification rows must go BEFORE the
    // store rows. Sweep processors can create these for any org present in the database, so a
    // fixture that never creates one itself can still be holding some at teardown time.
    await adminDb.delete(notifications).where(eq(notifications.organizationId, emptyOrgId));
    await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, emptyOrgId));
    await adminDb.delete(stores).where(eq(stores.organizationId, emptyOrgId));
    await adminDb.delete(organizations).where(eq(organizations.id, emptyOrgId));
  });

  it('findPending returns matches ordered worst-severity-first', async () => {
    const doc1 = await createPostedInvoiceDocument();
    const doc2 = await createPostedInvoiceDocument();
    // doc1: an unmapped SKU -> UNORDERED_ITEM (MEDIUM). doc2: no PO/receipt candidate exists
    // for a mapped SKU with nothing ever received against it in this org yet -> also a real,
    // distinctly-ordered case. Using an unmapped SKU for one and a genuinely unreceived PO for the
    // other keeps this test's two matches unambiguous without depending on resolveCandidate's
    // "most recent receipt for this product" tie-breaking across multiple POs for the same product.
    const { purchaseOrderId: po2 } = await createSentPurchaseOrder('10', '4.50');

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    await repo.runMatch({ documentId: doc1, storeId, supplierName, lines: [{ sku: { value: 'NEVER-MAPPED-FOR-PENDING-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }] });
    const result2 = await repo.runMatch({ documentId: doc2, storeId, supplierName, lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }] });

    expect(result2.purchaseOrderId).toBe(po2);
    expect(result2.highestSeverity).toBe('HIGH'); // INVOICED_NOT_RECEIVED: PO line exists, nothing ever received

    const pending = await repo.findPending(storeId);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(pending[0]?.highestSeverity).toBe('HIGH');

    // The variance queue's real "supplier name" and "estimated impact" gaps — both computed here,
    // not synthesized: supplierName is a real join, dollarImpact is the exact figure
    // computeMatchDollarImpact derives from this match's own lines (I2).
    expect(pending[0]?.supplierName).toBe(supplierName);
    const highSeverityMatch = pending.find((m) => m.id === result2.id);
    expect(highSeverityMatch?.dollarImpact?.toFixed(4)).toBe('45.0000'); // INVOICED_NOT_RECEIVED: 10 units x $4.50 = full exposure
  });

  it('findPending never returns a CLEAN match — a queue full of clean invoices defeats the point of \'s tolerances', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder('10', '4.50');
    await receiveAgainstPo(purchaseOrderId, purchaseOrderLineId, '10');
    const cleanDocumentId = await createPostedInvoiceDocument();

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const cleanResult = await repo.runMatch({
      documentId: cleanDocumentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
    });
    expect(cleanResult.highestSeverity).toBe('NONE');

    const pending = await repo.findPending(storeId);
    expect(pending.some((m) => m.id === cleanResult.id)).toBe(false);
  });

  it('resolve moves a PENDING match to RESOLVED with a real audit log entry, and refuses a second resolution', async () => {
    const { purchaseOrderId } = await createSentPurchaseOrder('10', '4.50');
    // Deliberately no receiveAgainstPo call -> INVOICED_NOT_RECEIVED, a real variance to resolve.
    const documentId = await createPostedInvoiceDocument();
    void purchaseOrderId;

    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'SUP-SKU-IM-TEST' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
    });
    expect(result.highestSeverity).toBe('HIGH');

    const userId = generateId();
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.insert(schema.users).values({ id: userId, email: `im-resolve-${userId}@example.test` });

    const resolution = await repo.resolve(result.id, userId, 'Confirmed with supplier — delivery was short-shipped, credit issued.');
    expect(resolution.ok).toBe(true);

    const [matchRow] = await adminDb.select().from(invoiceMatches).where(eq(invoiceMatches.id, result.id));
    expect(matchRow?.status).toBe('RESOLVED');
    expect(matchRow?.resolvedByUserId).toBe(userId);
    expect(matchRow?.resolutionNotes).toBe('Confirmed with supplier — delivery was short-shipped, credit issued.');
    expect(matchRow?.resolvedAt).not.toBeNull();

    const [auditRow] = await adminDb.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, result.id));
    expect(auditRow?.action).toBe('invoice_match.resolved');
    expect(auditRow?.actorUserId).toBe(userId);

    // A second resolution attempt must be refused, not silently overwrite the first.
    const second = await repo.resolve(result.id, userId, 'trying again');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('ALREADY_RESOLVED');

    // invoice_matches.resolved_by_user_id references this user — null it before deleting the user,
    // same FK-teardown-order discipline every other new column in this codebase has needed; the
    // shared afterEach's own invoice_matches delete runs AFTER this inline cleanup, so it can't help here.
    await adminDb.update(invoiceMatches).set({ resolvedByUserId: null }).where(eq(invoiceMatches.id, result.id));
    await adminDb.delete(schema.auditLogs).where(eq(schema.auditLogs.entityId, result.id));
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it('resolve returns NOT_FOUND for a match id that does not exist in this org', async () => {
    const repo = new InvoiceMatchRepository(createScopedDb(client), organizationId);
    const result = await repo.resolve(generateId(), generateId(), 'irrelevant');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_FOUND');
  });
});
