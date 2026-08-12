import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  createDb,
  documents,
  goodsReceiptLines,
  goodsReceipts,
  invoiceMatchLines,
  invoiceMatches,
  lots,
  memberships,
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
  units,
  users,
  InvoiceMatchRepository,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('invoiceMatches — get/getByDocument/pending/resolve (008-10, 008-12)', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sessionStore = new SessionStore(redis);
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(invoiceMatchLines).where(eq(invoiceMatchLines.organizationId, orgId));
      await db.delete(invoiceMatches).where(eq(invoiceMatches.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      // setUpCleanMatch drives a real goodsReceipts.confirmReceipt call — goods_receipt_lines
      // references purchase_order_lines, and lots<->goods_receipt_lines forms the same genuine
      // mutual FK cycle goods-receipts.test.ts's own teardown documents; null one side before
      // deleting either table, same recurring FK-teardown-order class this project keeps hitting.
      await db.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await db.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await db.update(lots).set({ goodsReceiptLineId: null }).where(eq(lots.organizationId, orgId));
      await db.delete(goodsReceiptLines).where(eq(goodsReceiptLines.organizationId, orgId));
      await db.delete(lots).where(eq(lots.organizationId, orgId));
      await db.delete(goodsReceipts).where(eq(goodsReceipts.organizationId, orgId));
      await db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, orgId));
      await db.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));

      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));
      await db.delete(memberships).where(eq(memberships.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    for (const userId of createdUserIds) {
      await db.delete(users).where(eq(users.id, userId));
    }
    createdOrgIds.length = 0;
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const call = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/trpc/${path}`, cookies: { '__Host-session': cookie }, payload: input });

  const query = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({ method: 'GET', url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, cookies: { '__Host-session': cookie } });

  const issueSession = async (organizationId: string, permissions: Permission[]): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `im-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role: 'OWNER', acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  /** A real CLEAN invoice match: a fully-received SENT PO matched against an exact-quantity/price invoice line. */
  const setUpCleanMatch = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `IM Router Test Org ${organizationId}`, slug: `im-router-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    const supplierId = generateId();
    const supplierName = `IM Router Test Supplier ${generateId()}`;
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: supplierName });

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();
    await db.insert(products).values({ id: productId, organizationId, sku: `IM-ROUTER-${productId}`, name: 'IM Router Test Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
    const supplierProductId = generateId();
    await db.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: 'IM-ROUTER-SUP-SKU', isConfirmed: true });

    const token = await issueSession(organizationId, ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const createResponse = await call('purchaseOrders.create', token, { storeId, supplierId, poNumber: `PO-IM-${generateId()}` });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;
    await call('purchaseOrders.addLine', token, { purchaseOrderId, supplierProductId, productId, quantityOrderUnits: '10', orderUnitId: kgUnit!.id, conversionToBase: '1', unitPrice: '4.50', lineNumber: 1 });
    await call('purchaseOrders.submit', token, { purchaseOrderId, expectedVersion: 1 });
    await call('purchaseOrders.approve', token, { purchaseOrderId, expectedVersion: 2 });
    await call('purchaseOrders.send', token, { purchaseOrderId, expectedVersion: 3 });
    const getResponse = await query('purchaseOrders.get', token, { purchaseOrderId });
    const purchaseOrderLineId = JSON.parse(getResponse.body).result.data.lines[0].id;
    await call('goodsReceipts.confirmReceipt', token, {
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '10', lineNumber: 1 }],
    });

    const documentId = generateId();
    await db.insert(documents).values({
      id: documentId,
      organizationId,
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      status: 'POSTED',
      storageKey: `${organizationId}/im-router-test-${documentId}.pdf`,
      contentHash: `im-router-hash-${documentId}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    const repo = new InvoiceMatchRepository(db, organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'IM-ROUTER-SUP-SKU' }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
    });

    return { organizationId, storeId, documentId, invoiceMatchId: result.id, token };
  };

  /** A real match with a genuine variance (UNORDERED_ITEM — no supplier-product mapping exists at all) — the review-queue/resolve fixture. */
  const setUpVarianceMatch = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `IM Variance Test Org ${organizationId}`, slug: `im-variance-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    const supplierId = generateId();
    const supplierName = `IM Variance Test Supplier ${generateId()}`;
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: supplierName });

    const token = await issueSession(organizationId, ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const documentId = generateId();
    await db.insert(documents).values({
      id: documentId,
      organizationId,
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      status: 'POSTED',
      storageKey: `${organizationId}/im-variance-test-${documentId}.pdf`,
      contentHash: `im-variance-hash-${documentId}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    const repo = new InvoiceMatchRepository(db, organizationId);
    const result = await repo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'NEVER-MAPPED-VARIANCE-SKU' }, quantity: { value: '3' }, unitPrice: { value: '9.00' } }],
    });

    return { organizationId, storeId, documentId, invoiceMatchId: result.id, token };
  };

  it('get returns the real match and its lines for a caller with purchasing:read', async () => {
    const { documentId, invoiceMatchId, token } = await setUpCleanMatch();
    void documentId;

    const response = await query('invoiceMatches.get', token, { invoiceMatchId });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.invoiceMatch.id).toBe(invoiceMatchId);
    expect(body.invoiceMatch.highestSeverity).toBe('NONE');
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].varianceType).toBe('CLEAN');
  });

  it('get returns 403 for a session with no purchasing:read permission', async () => {
    const { invoiceMatchId, organizationId } = await setUpCleanMatch();
    const noPermToken = await issueSession(organizationId, []);

    const response = await query('invoiceMatches.get', noPermToken, { invoiceMatchId });
    expect(response.statusCode).toBe(403);
  });

  it('getByDocument resolves the real match by documentId', async () => {
    const { documentId, invoiceMatchId, token } = await setUpCleanMatch();

    const response = await query('invoiceMatches.getByDocument', token, { documentId });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.invoiceMatch.id).toBe(invoiceMatchId);
  });

  it('getByDocument returns null (not an error) for a document that was never matched', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `IM Unmatched Org ${organizationId}`, slug: `im-unmatched-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'UTC' });
    const documentId = generateId();
    await db.insert(documents).values({
      id: documentId,
      organizationId,
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      status: 'UPLOADED',
      storageKey: `${organizationId}/never-matched.pdf`,
      contentHash: `never-matched-hash-${documentId}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    const token = await issueSession(organizationId, ['purchasing:read']);

    const response = await query('invoiceMatches.getByDocument', token, { documentId });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toBeNull();
  });

  it('pending returns a match with a real variance, store-scoped, ordered worst-severity-first', async () => {
    const { storeId, invoiceMatchId, token } = await setUpVarianceMatch();

    const response = await query('invoiceMatches.pending', token, { storeId });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data as { id: string }[];
    expect(body.some((m) => m.id === invoiceMatchId)).toBe(true);
  });

  it('pending never returns a CLEAN match — 008-12, a queue full of clean invoices defeats the point', async () => {
    const { storeId, invoiceMatchId, token } = await setUpCleanMatch();

    const response = await query('invoiceMatches.pending', token, { storeId });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data as { id: string }[];
    expect(body.some((m) => m.id === invoiceMatchId)).toBe(false);
  });

  it('pending returns 404 for a storeId belonging to a different organization', async () => {
    const { token } = await setUpCleanMatch();
    const otherOrgId = generateId();
    createdOrgIds.push(otherOrgId);
    await db.insert(organizations).values({ id: otherOrgId, name: `IM Other Org ${otherOrgId}`, slug: `im-other-org-${otherOrgId}`, baseCurrency: 'USD' });
    const otherStoreId = generateId();
    await db.insert(stores).values({ id: otherStoreId, organizationId: otherOrgId, name: 'Other Store', timezone: 'UTC' });

    const response = await query('invoiceMatches.pending', token, { storeId: otherStoreId });
    expect(response.statusCode).toBe(404);
  });

  it('resolve moves a real variance match to RESOLVED and it no longer appears in pending', async () => {
    const { storeId, invoiceMatchId, token } = await setUpVarianceMatch();

    const resolveResponse = await call('invoiceMatches.resolve', token, {
      invoiceMatchId,
      resolutionNotes: 'Confirmed with the supplier — a one-off delivery fee, not a real product line.',
    });
    expect(resolveResponse.statusCode).toBe(200);
    const body = JSON.parse(resolveResponse.body).result.data;
    expect(body.status).toBe('RESOLVED');
    expect(body.resolutionNotes).toBe('Confirmed with the supplier — a one-off delivery fee, not a real product line.');
    expect(body.resolvedAt).not.toBeNull();

    const pendingResponse = await query('invoiceMatches.pending', token, { storeId });
    const pendingBody = JSON.parse(pendingResponse.body).result.data as { id: string }[];
    expect(pendingBody.some((m) => m.id === invoiceMatchId)).toBe(false);
  });

  it('resolve requires purchasing:approve — a session with only purchasing:read/write gets 403', async () => {
    const { organizationId, invoiceMatchId } = await setUpVarianceMatch();
    const limitedToken = await issueSession(organizationId, ['purchasing:read', 'purchasing:write']);

    const response = await call('invoiceMatches.resolve', limitedToken, { invoiceMatchId, resolutionNotes: 'irrelevant' });
    expect(response.statusCode).toBe(403);
  });

  it('resolve rejects an empty resolution note with a real 400', async () => {
    const { invoiceMatchId, token } = await setUpVarianceMatch();

    const response = await call('invoiceMatches.resolve', token, { invoiceMatchId, resolutionNotes: '' });
    expect(response.statusCode).toBe(400);
  });

  it('resolve rejects a second resolution attempt on an already-resolved match with a real 400', async () => {
    const { invoiceMatchId, token } = await setUpVarianceMatch();

    const first = await call('invoiceMatches.resolve', token, { invoiceMatchId, resolutionNotes: 'first resolution' });
    expect(first.statusCode).toBe(200);

    const second = await call('invoiceMatches.resolve', token, { invoiceMatchId, resolutionNotes: 'second attempt' });
    expect(second.statusCode).toBe(400);
  });

  it('resolve returns 404 for an invoiceMatchId that does not exist in the caller\'s org', async () => {
    const { organizationId } = await setUpVarianceMatch();
    const token = await issueSession(organizationId, ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const response = await call('invoiceMatches.resolve', token, { invoiceMatchId: generateId(), resolutionNotes: 'irrelevant' });
    expect(response.statusCode).toBe(404);
  });
});
