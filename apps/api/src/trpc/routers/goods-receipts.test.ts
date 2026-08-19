import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  createDb,
  goodsReceiptLines,
  goodsReceipts,
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
  supplierPerformanceEvents,
  units,
  users,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('goodsReceipts — confirmReceipt/get', () => {
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
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      // supplier_performance_events references goods_receipts (and purchase_orders/documents
      // in other test files) — must be deleted before those parent tables, the same recurring
      // FK-teardown-order class every new table with provenance FKs to already-existing tables hits.
      await db.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, orgId));
      await db.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await db.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      // lots <-> goods_receipt_lines is a genuine mutual FK cycle (this task's own migration) —
      // null one side before deleting either table.
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
    await db.insert(users).values({ id: userId, email: `gr-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role: 'OWNER', acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  /** earlier work: a real store/supplier/product with NO purchase order at all — the walk-in-receipt fixture. */
  const setUpStoreSupplierProduct = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `GR Walk-In Test Org ${organizationId}`, slug: `gr-walkin-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    const supplierId = generateId();
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'GR Walk-In Test Supplier' });

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();
    await db.insert(products).values({ id: productId, organizationId, sku: `GR-WALKIN-${productId}`, name: 'GR Walk-In Test Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });

    const token = await issueSession(organizationId, ['purchasing:read', 'purchasing:write', 'purchasing:approve']);
    return { organizationId, storeId, supplierId, productId, variantId, token };
  };

  const setUpSentPurchaseOrder = async (quantityOrderUnits: string, unitPrice: string) => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `GR Router Test Org ${organizationId}`, slug: `gr-router-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    const supplierId = generateId();
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'GR Router Test Supplier' });

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();
    await db.insert(products).values({ id: productId, organizationId, sku: `GR-ROUTER-${productId}`, name: 'GR Router Test Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
    const supplierProductId = generateId();
    await db.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: 'GR-ROUTER-SUP-SKU', isConfirmed: true });

    const token = await issueSession(organizationId, ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const createResponse = await call('purchaseOrders.create', token, { storeId, supplierId, poNumber: `PO-GR-${generateId()}` });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;
    await call('purchaseOrders.addLine', token, { purchaseOrderId, supplierProductId, productId, quantityOrderUnits, orderUnitId: kgUnit!.id, conversionToBase: '1', unitPrice, lineNumber: 1 });
    await call('purchaseOrders.submit', token, { purchaseOrderId, expectedVersion: 1 });
    await call('purchaseOrders.approve', token, { purchaseOrderId, expectedVersion: 2 });
    await call('purchaseOrders.send', token, { purchaseOrderId, expectedVersion: 3 });

    const getResponse = await query('purchaseOrders.get', token, { purchaseOrderId });
    const purchaseOrderLineId = JSON.parse(getResponse.body).result.data.lines[0].id;

    return { organizationId, storeId, supplierId, productId, variantId, purchaseOrderId, purchaseOrderLineId, token };
  };

  it('confirmReceipt with a full quantity moves the PO to RECEIVED and returns a real goodsReceiptId', async () => {
    const { storeId, supplierId, purchaseOrderId, purchaseOrderLineId, token } = await setUpSentPurchaseOrder('10', '5.00');

    const response = await call('goodsReceipts.confirmReceipt', token, {
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '10', lineNumber: 1 }],
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.purchaseOrderNewStatus).toBe('RECEIVED');
    expect(body.goodsReceiptId).toBeTruthy();

    const getResponse = await query('purchaseOrders.get', token, { purchaseOrderId });
    expect(JSON.parse(getResponse.body).result.data.purchaseOrder.status).toBe('RECEIVED');
  });

  it('confirmReceipt returns a real receipt with its lines via get', async () => {
    const { storeId, supplierId, purchaseOrderId, purchaseOrderLineId, productId, token } = await setUpSentPurchaseOrder('5', '2.00');

    const confirmResponse = await call('goodsReceipts.confirmReceipt', token, {
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '5', lotNumber: 'LOT-1', lineNumber: 1 }],
    });
    const goodsReceiptId = JSON.parse(confirmResponse.body).result.data.goodsReceiptId;

    const getResponse = await query('goodsReceipts.get', token, { goodsReceiptId });
    expect(getResponse.statusCode).toBe(200);
    const body = JSON.parse(getResponse.body).result.data;
    expect(body.goodsReceipt.purchaseOrderId).toBe(purchaseOrderId);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].productId).toBe(productId);
    expect(body.lines[0].lotNumber).toBe('LOT-1');
  });

  it('a partial receipt leaves the PO PARTIALLY_RECEIVED with the real remaining quantity still outstanding', async () => {
    const { storeId, supplierId, purchaseOrderId, purchaseOrderLineId, token } = await setUpSentPurchaseOrder('10', '5.00');

    const response = await call('goodsReceipts.confirmReceipt', token, {
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '4', discrepancyCode: 'SHORT', lineNumber: 1 }],
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data.purchaseOrderNewStatus).toBe('PARTIALLY_RECEIVED');

    const getResponse = await query('purchaseOrders.get', token, { purchaseOrderId });
    const body = JSON.parse(getResponse.body).result.data;
    expect(body.purchaseOrder.status).toBe('PARTIALLY_RECEIVED');
    expect(body.lines[0].receivedQuantityBaseUnits).toBe('4.000000');
  });

  it('a receipt exceeding the ordered quantity is rejected with a real 400, not a silent overcredit', async () => {
    const { storeId, supplierId, purchaseOrderId, purchaseOrderLineId, token } = await setUpSentPurchaseOrder('5', '5.00');

    const response = await call('goodsReceipts.confirmReceipt', token, {
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '99', lineNumber: 1 }],
    });
    expect(response.statusCode).toBe(400);
  });

  it('a STAFF session (no purchasing:write) is rejected with 403', async () => {
    const { storeId, supplierId, purchaseOrderId, purchaseOrderLineId, organizationId } = await setUpSentPurchaseOrder('5', '5.00');
    const staffUserId = generateId();
    createdUserIds.push(staffUserId);
    const { token: staffToken } = await sessionStore.create(
      { userId: staffUserId, organizationId, storeIds: 'ALL', role: 'STAFF', permissions: ['inventory:read'] },
      '127.0.0.1',
      'test-agent'
    );

    const response = await call('goodsReceipts.confirmReceipt', staffToken, {
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '5', lineNumber: 1 }],
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a storeId from a different organization (cross-tenant, I4)', async () => {
    const orgA = await setUpSentPurchaseOrder('5', '5.00');
    const orgB = await setUpSentPurchaseOrder('5', '5.00');

    const response = await call('goodsReceipts.confirmReceipt', orgB.token, {
      storeId: orgA.storeId,
      purchaseOrderId: orgA.purchaseOrderId,
      supplierId: orgA.supplierId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId: orgA.purchaseOrderLineId, receivedQuantityBaseUnits: '5', lineNumber: 1 }],
    });
    expect(response.statusCode).toBe(404);
  });

  describe('receipt without a PO — walk-in/emergency purchases', () => {
    it('confirmReceipt with no purchaseOrderId succeeds over real HTTP, using an explicit productId/unitCost per line', async () => {
      const { storeId, supplierId, productId, variantId, token } = await setUpStoreSupplierProduct();

      const response = await call('goodsReceipts.confirmReceipt', token, {
        storeId,
        supplierId,
        receivedAt: new Date().toISOString(),
        notes: 'Emergency grocery run',
        lines: [{ productId, variantId, receivedQuantityBaseUnits: '4', unitCost: '6.25', currency: 'USD', lineNumber: 1 }],
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data;
      expect(body.purchaseOrderNewStatus).toBeNull();
      expect(body.goodsReceiptId).toBeTruthy();

      const getResponse = await query('goodsReceipts.get', token, { goodsReceiptId: body.goodsReceiptId });
      expect(getResponse.statusCode).toBe(200);
      const getBody = JSON.parse(getResponse.body).result.data;
      expect(getBody.goodsReceipt.purchaseOrderId).toBeNull();
      expect(getBody.lines[0].purchaseOrderLineId).toBeNull();
      expect(getBody.lines[0].unitCost).toBe('6.2500');
    });

    it('a walk-in line with no productId AND no purchaseOrderLineId is rejected with a real 400 (MissingReceiveLineProductError)', async () => {
      const { storeId, supplierId, token } = await setUpStoreSupplierProduct();

      const response = await call('goodsReceipts.confirmReceipt', token, {
        storeId,
        supplierId,
        receivedAt: new Date().toISOString(),
        lines: [{ receivedQuantityBaseUnits: '4', unitCost: '6.25', lineNumber: 1 }],
      });
      expect(response.statusCode).toBe(400);
    });

    it('a walk-in line with a productId but no unitCost is rejected with a real 400 (UnknownReceiptCostError, never a guessed 0 — I7)', async () => {
      const { storeId, supplierId, productId, variantId, token } = await setUpStoreSupplierProduct();

      const response = await call('goodsReceipts.confirmReceipt', token, {
        storeId,
        supplierId,
        receivedAt: new Date().toISOString(),
        lines: [{ productId, variantId, receivedQuantityBaseUnits: '4', lineNumber: 1 }],
      });
      expect(response.statusCode).toBe(400);
    });
  });
});

/**
 * earlier work ("photos for damage claims"): real Postgres + real Redis + real MinIO + real HTTP — proves
 * the two-step presigned-upload flow end to end, matching `products.test.ts`'s own precedent exactly.
 */
describe('goodsReceipts — requestPhotoUpload/confirmPhotoUpload', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sessionStore = new SessionStore(redis);
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  const REAL_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, orgId));
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

  const setUpReceiptLine = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `GR Photo Test Org ${organizationId}`, slug: `gr-photo-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    const supplierId = generateId();
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'GR Photo Test Supplier' });

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();
    await db.insert(products).values({ id: productId, organizationId, sku: `GR-PHOTO-${productId}`, name: 'GR Photo Test Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
    const supplierProductId = generateId();
    await db.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: 'GR-PHOTO-SUP-SKU', isConfirmed: true });

    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `gr-photo-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role: 'OWNER', acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions: ['purchasing:read', 'purchasing:write', 'purchasing:approve'] }, '127.0.0.1', 'test-agent');

    const createResponse = await call('purchaseOrders.create', token, { storeId, supplierId, poNumber: `PO-GR-PHOTO-${generateId()}` });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;
    await call('purchaseOrders.addLine', token, { purchaseOrderId, supplierProductId, productId, quantityOrderUnits: '5', orderUnitId: kgUnit!.id, conversionToBase: '1', unitPrice: '5.00', lineNumber: 1 });
    await call('purchaseOrders.submit', token, { purchaseOrderId, expectedVersion: 1 });
    await call('purchaseOrders.approve', token, { purchaseOrderId, expectedVersion: 2 });
    await call('purchaseOrders.send', token, { purchaseOrderId, expectedVersion: 3 });
    const poGet = await query('purchaseOrders.get', token, { purchaseOrderId });
    const purchaseOrderLineId = JSON.parse(poGet.body).result.data.lines[0].id;

    const receiptResponse = await call('goodsReceipts.confirmReceipt', token, {
      storeId, purchaseOrderId, supplierId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '5', discrepancyCode: 'DAMAGED', lineNumber: 1 }],
    });
    const goodsReceiptId = JSON.parse(receiptResponse.body).result.data.goodsReceiptId;
    const grGet = await query('goodsReceipts.get', token, { goodsReceiptId });
    const goodsReceiptLineId = JSON.parse(grGet.body).result.data.lines[0].id;

    return { token, goodsReceiptLineId, organizationId };
  };

  it('the full two-step flow: a real presigned URL, a real PUT, and a real magic-byte-verified confirm appends the key', async () => {
    const { token, goodsReceiptLineId } = await setUpReceiptLine();

    const requestResponse = await call('goodsReceipts.requestPhotoUpload', token, { goodsReceiptLineId, contentType: 'image/jpeg' });
    expect(requestResponse.statusCode).toBe(200);
    const { uploadUrl, key } = JSON.parse(requestResponse.body).result.data;
    expect(uploadUrl).toMatch(/^http/);

    const putResponse = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: REAL_JPEG_BYTES });
    expect(putResponse.status).toBe(200);

    const confirmResponse = await call('goodsReceipts.confirmPhotoUpload', token, { goodsReceiptLineId, key });
    expect(confirmResponse.statusCode).toBe(200);
    expect(JSON.parse(confirmResponse.body).result.data.key).toBe(key);

    const grLineRow = (await db.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.id, goodsReceiptLineId)))[0];
    expect(grLineRow!.photoObjectKeys).toEqual([key]);
  });

  it('confirmPhotoUpload rejects bytes that are not a real image (magic-byte verification, not the claimed content-type)', async () => {
    const { token, goodsReceiptLineId } = await setUpReceiptLine();

    const requestResponse = await call('goodsReceipts.requestPhotoUpload', token, { goodsReceiptLineId, contentType: 'image/jpeg' });
    const { uploadUrl, key } = JSON.parse(requestResponse.body).result.data;

    await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('not a real image') });

    const confirmResponse = await call('goodsReceipts.confirmPhotoUpload', token, { goodsReceiptLineId, key });
    expect(confirmResponse.statusCode).toBe(400);
  });

  it('a second photo on the same line is appended, not overwriting the first', async () => {
    const { token, goodsReceiptLineId } = await setUpReceiptLine();

    for (let i = 0; i < 2; i++) {
      const requestResponse = await call('goodsReceipts.requestPhotoUpload', token, { goodsReceiptLineId, contentType: 'image/jpeg' });
      const { uploadUrl, key } = JSON.parse(requestResponse.body).result.data;
      await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: REAL_JPEG_BYTES });
      await call('goodsReceipts.confirmPhotoUpload', token, { goodsReceiptLineId, key });
    }

    const grLineRow = (await db.select().from(goodsReceiptLines).where(eq(goodsReceiptLines.id, goodsReceiptLineId)))[0];
    expect(grLineRow!.photoObjectKeys).toHaveLength(2);
  });

  it('requestPhotoUpload 404s for a line that does not exist', async () => {
    const { token } = await setUpReceiptLine();
    const response = await call('goodsReceipts.requestPhotoUpload', token, { goodsReceiptLineId: generateId(), contentType: 'image/jpeg' });
    expect(response.statusCode).toBe(404);
  });
});
