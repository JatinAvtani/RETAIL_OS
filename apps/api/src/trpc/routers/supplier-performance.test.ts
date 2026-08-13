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
  supplierPerformanceEvents,
  units,
  users,
  InvoiceMatchRepository,
  SupplierPerformanceEventRepository,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('supplierPerformance — components/events (008-13)', () => {
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
      await db.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, orgId));
      await db.delete(invoiceMatchLines).where(eq(invoiceMatchLines.organizationId, orgId));
      await db.delete(invoiceMatches).where(eq(invoiceMatches.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      // The same genuine mutual FK cycle every 008-1x router test hits: lots <-> goods_receipt_lines.
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
    await db.insert(users).values({ id: userId, email: `spr-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role: 'OWNER', acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  /**
   * Drives a real PO -> SENT -> a real SHORT receipt (8 of 10 ordered) -> a real INVOICE billed at
   * a genuine price variance, matched via `documents.approve`'s own real path (`InvoiceMatchRepository
   * .runMatch`) — the same real emission points 008-13 wired into `confirmReceipt`/`runMatch`, so
   * this fixture proves the whole chain end to end over real HTTP, not a directly-inserted event row.
   */
  const setUpSupplierWithRealPerformanceHistory = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `SPR Router Test Org ${organizationId}`, slug: `spr-router-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    const supplierId = generateId();
    const supplierName = `SPR Router Test Supplier ${generateId()}`;
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: supplierName });

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();
    await db.insert(products).values({ id: productId, organizationId, sku: `SPR-ROUTER-${productId}`, name: 'SPR Router Test Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
    const supplierProductId = generateId();
    await db.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: 'SPR-ROUTER-SUP-SKU', isConfirmed: true });

    const token = await issueSession(organizationId, ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const createResponse = await call('purchaseOrders.create', token, { storeId, supplierId, poNumber: `PO-SPR-${generateId()}` });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;
    await call('purchaseOrders.addLine', token, { purchaseOrderId, supplierProductId, productId, quantityOrderUnits: '10', orderUnitId: kgUnit!.id, conversionToBase: '1', unitPrice: '5.00', lineNumber: 1 });
    await call('purchaseOrders.submit', token, { purchaseOrderId, expectedVersion: 1 });
    await call('purchaseOrders.approve', token, { purchaseOrderId, expectedVersion: 2 });
    await call('purchaseOrders.send', token, { purchaseOrderId, expectedVersion: 3 });
    const getResponse = await query('purchaseOrders.get', token, { purchaseOrderId });
    const purchaseOrderLineId = JSON.parse(getResponse.body).result.data.lines[0].id;

    // A real SHORT receipt: 8 of the 10 ordered -> a real FILL_SHORT event.
    await call('goodsReceipts.confirmReceipt', token, {
      storeId,
      purchaseOrderId,
      supplierId,
      receivedAt: new Date().toISOString(),
      lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '8', lineNumber: 1 }],
    });

    const documentId = generateId();
    await db.insert(documents).values({
      id: documentId,
      organizationId,
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      status: 'POSTED',
      storageKey: `${organizationId}/spr-router-test-${documentId}.pdf`,
      contentHash: `spr-router-hash-${documentId}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    // A real price variance well beyond BOTH the default 2% and $5 absolute tolerance ($5.00 PO
    // price vs $20.00 invoiced -> $15 absolute / 300% relative) -> a real PRICE_VARIANCE +
    // INVOICE_ERROR event. A smaller gap (e.g. $8 vs $5, a $3 absolute variance) is silently
    // CLEAN under the real default tolerance ($5 absolute) — confirmed by re-deriving from the
    // actual classifyLineMatch behavior, not hand-guessed.
    const matchRepo = new InvoiceMatchRepository(db, organizationId);
    await matchRepo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: 'SPR-ROUTER-SUP-SKU' }, quantity: { value: '8' }, unitPrice: { value: '20.00' } }],
    });

    return { organizationId, storeId, supplierId, productId, token };
  };

  it('components returns real fill/price/invoice figures computed from real events, not fabricated ones', async () => {
    const { supplierId, token } = await setUpSupplierWithRealPerformanceHistory();

    const response = await query('supplierPerformance.components', token, { supplierId, days: 30 });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.fillRate).toBeCloseTo(0.8, 10); // 8 received of 10 ordered
    expect(body.invoiceAccuracy).toBe(0); // the one real invoice matched had a real error
    expect(body.totalPriceVariance).not.toBeNull();
    expect(Number(body.totalPriceVariance)).toBeGreaterThan(0);
    expect(body.qualityRejectRate).toBe(0); // no discrepancy-coded lines in this fixture
  });

  it('components returns every field null for a supplier with zero real history — I7, never a fabricated rate', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `SPR Empty Org ${organizationId}`, slug: `spr-empty-${organizationId}`, baseCurrency: 'USD' });
    const supplierId = generateId();
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'No History Supplier' });
    const token = await issueSession(organizationId, ['purchasing:read']);

    const response = await query('supplierPerformance.components', token, { supplierId, days: 30 });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body).toEqual({ fillRate: null, onTimeRate: null, totalPriceVariance: null, invoiceAccuracy: null, qualityRejectRate: null });
  });

  it('events returns the real underlying rows a component figure was drilled down from', async () => {
    const { supplierId, productId, token } = await setUpSupplierWithRealPerformanceHistory();

    const response = await query('supplierPerformance.events', token, { supplierId, days: 30 });
    expect(response.statusCode).toBe(200);
    const events = JSON.parse(response.body).result.data as { eventType: string; productId: string | null }[];
    const types = events.map((e) => e.eventType).sort();
    expect(types).toContain('FILL_SHORT');
    expect(types).toContain('PRICE_VARIANCE');
    expect(types).toContain('INVOICE_ERROR');

    const narrowed = await query('supplierPerformance.events', token, { supplierId, days: 30, productId });
    const narrowedEvents = JSON.parse(narrowed.body).result.data as { productId: string | null }[];
    expect(narrowedEvents.length).toBeGreaterThan(0);
    expect(narrowedEvents.every((e) => e.productId === productId)).toBe(true);
  });

  it('a real session lacking purchasing:read gets 403 on all three endpoints', async () => {
    const { supplierId, token: ownerToken } = await setUpSupplierWithRealPerformanceHistory();
    void ownerToken;
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `SPR 403 Org ${organizationId}`, slug: `spr-403-${organizationId}`, baseCurrency: 'USD' });
    const noReadToken = await issueSession(organizationId, ['documents:read']);

    const componentsResponse = await query('supplierPerformance.components', noReadToken, { supplierId, days: 30 });
    expect(componentsResponse.statusCode).toBe(403);

    const eventsResponse = await query('supplierPerformance.events', noReadToken, { supplierId, days: 30 });
    expect(eventsResponse.statusCode).toBe(403);

    const trendResponse = await query('supplierPerformance.trend', noReadToken, { supplierId, days: 30 });
    expect(trendResponse.statusCode).toBe(403);
  });

  it('a cross-org supplierId returns a real 404, never a 200-empty response', async () => {
    const { supplierId } = await setUpSupplierWithRealPerformanceHistory();

    const otherOrgId = generateId();
    createdOrgIds.push(otherOrgId);
    await db.insert(organizations).values({ id: otherOrgId, name: `SPR Other Org ${otherOrgId}`, slug: `spr-other-${otherOrgId}`, baseCurrency: 'USD' });
    const otherOrgToken = await issueSession(otherOrgId, ['purchasing:read']);

    const response = await query('supplierPerformance.components', otherOrgToken, { supplierId, days: 30 });
    expect(response.statusCode).toBe(404);

    const trendResponse = await query('supplierPerformance.trend', otherOrgToken, { supplierId, days: 30 });
    expect(trendResponse.statusCode).toBe(404);
  });

  describe('trend (008-15)', () => {
    it('a real improving on-time rate between two real windows is flagged "up", with the real previous/current values', async () => {
      const organizationId = generateId();
      createdOrgIds.push(organizationId);
      await db.insert(organizations).values({ id: organizationId, name: `SPR Trend Org ${organizationId}`, slug: `spr-trend-${organizationId}`, baseCurrency: 'USD' });
      const supplierId = generateId();
      await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'Trend Test Supplier' });
      const token = await issueSession(organizationId, ['purchasing:read']);

      const now = Date.now();
      const insertEvent = (eventType: 'DELIVERY_ON_TIME' | 'DELIVERY_LATE', occurredAt: Date) =>
        db.transaction((tx) => SupplierPerformanceEventRepository.recordInTx(tx, organizationId, { organizationId, supplierId, eventType, occurredAt }));

      // With days=30: current window is [now-30d, now), previous window is [now-60d, now-30d).
      // Previous window (35/40 days ago, inside [now-60d, now-30d)): 1 on-time, 1 late -> 50%.
      await insertEvent('DELIVERY_ON_TIME', new Date(now - 35 * 24 * 60 * 60 * 1000));
      await insertEvent('DELIVERY_LATE', new Date(now - 40 * 24 * 60 * 60 * 1000));
      // Current window (0-30 days ago): 2 on-time -> 100%.
      await insertEvent('DELIVERY_ON_TIME', new Date(now - 5 * 24 * 60 * 60 * 1000));
      await insertEvent('DELIVERY_ON_TIME', new Date(now - 10 * 24 * 60 * 60 * 1000));

      const response = await query('supplierPerformance.trend', token, { supplierId, days: 30 });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data;
      expect(body.onTimeRate.current).toBe(1);
      expect(body.onTimeRate.previous).toBe(0.5);
      expect(body.onTimeRate.direction).toBe('up');
    });

    it('a real value in the current window with no history in the previous window is a null direction, never a fabricated "up"', async () => {
      const organizationId = generateId();
      createdOrgIds.push(organizationId);
      await db.insert(organizations).values({ id: organizationId, name: `SPR Trend No History Org ${organizationId}`, slug: `spr-trend-nohist-${organizationId}`, baseCurrency: 'USD' });
      const supplierId = generateId();
      await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'Trend No History Supplier' });
      const token = await issueSession(organizationId, ['purchasing:read']);

      await db.transaction((tx) =>
        SupplierPerformanceEventRepository.recordInTx(tx, organizationId, { organizationId, supplierId, eventType: 'DELIVERY_ON_TIME', occurredAt: new Date() })
      );

      const response = await query('supplierPerformance.trend', token, { supplierId, days: 30 });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data;
      expect(body.onTimeRate.current).toBe(1);
      expect(body.onTimeRate.previous).toBeNull();
      expect(body.onTimeRate.direction).toBeNull();
    });
  });
});
