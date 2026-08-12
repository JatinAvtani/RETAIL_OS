import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import {
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

  const createSentPurchaseOrder = async (quantityOrderUnits: string, unitPrice: string) => {
    const poRepo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-IM-${generateId()}`, currency: 'USD' });
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

  it('a widened org-level price tolerance turns a would-be variance into CLEAN — 008-11', async () => {
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

  it('a partial org override (price only) still uses the real default for quantity tolerance — 008-11', async () => {
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

  it('matches a walk-in receipt (no PO at all) purely by product/supplier — 008-09 integration', async () => {
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
  });

  it('findPending never returns a CLEAN match — 008-12, a queue full of clean invoices defeats the point of 008-11\'s tolerances', async () => {
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
