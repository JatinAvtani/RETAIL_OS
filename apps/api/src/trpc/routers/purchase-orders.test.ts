import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  createDb,
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
  supplierPrices,
  supplierProducts,
  units,
  users,
  MovementService,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('purchaseOrders.reorderSuggestions', () => {
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
      await db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, orgId));
      await db.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));
      await db.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));

      const orgSupplierProducts = await db
        .select({ id: supplierProducts.id })
        .from(supplierProducts)
        .where(eq(supplierProducts.organizationId, orgId));
      for (const sp of orgSupplierProducts) {
        await db.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, sp.id));
      }
      await db.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));

      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Reorder Suggestions Test Org ${organizationId}`,
      slug: `reorder-suggestions-router-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const issueSession = async (organizationId: string): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    const { token } = await sessionStore.create(
      { userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions: [] },
      '127.0.0.1',
      'test-agent'
    );
    return token;
  };

  const fetchSuggestions = async (storeId: string, cookie: string) =>
    app.inject({
      method: 'GET',
      url: `/trpc/purchaseOrders.reorderSuggestions?input=${encodeURIComponent(JSON.stringify({ storeId }))}`,
      cookies: { '__Host-session': cookie },
    });

  it('rejects a request with no session cookie (401)', async () => {
    const { storeId } = await setUpOrg();
    const response = await app.inject({
      method: 'GET',
      url: `/trpc/purchaseOrders.reorderSuggestions?input=${encodeURIComponent(JSON.stringify({ storeId }))}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('an org with no confirmed supplier products returns an empty array, not an error', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const cookie = await issueSession(organizationId);

    const response = await fetchSuggestions(storeId, cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body).toEqual([]);
  });

  it('returns a real, grouped suggestion for a genuinely low-stock, steadily-consumed product', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const cookie = await issueSession(organizationId);

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const supplierId = generateId();
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'Router Test Supplier', leadTimeDaysContracted: 2 });

    const productId = generateId();
    await db.insert(products).values({ id: productId, organizationId, sku: `PO-ROUTER-${productId}`, name: 'Router Test Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });

    await db.insert(supplierProducts).values({
      id: generateId(),
      organizationId,
      supplierId,
      productId,
      supplierSku: 'ROUTER-SUP-SKU',
      isConfirmed: true,
      packSize: '12',
      packUnitId: kgUnit!.id,
    });

    const movementService = new MovementService(db, organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '5',
      unitCost: '2.00',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      sourceType: 'TEST',
    });
    for (let i = 0; i < 10; i++) {
      await movementService.postMovement({
        storeId,
        productId,
        variantId,
        movementType: 'SALE_CONSUMPTION',
        quantity: '-1',
        currency: 'USD',
        occurredAt: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000),
        sourceType: 'TEST',
      });
    }

    const response = await fetchSuggestions(storeId, cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body).toHaveLength(1);
    expect(body[0].supplierName).toBe('Router Test Supplier');
    expect(body[0].suggestions).toHaveLength(1);
    expect(body[0].suggestions[0].productId).toBe(productId);
    expect(body[0].suggestions[0].explanationText).toMatch(/Suggest/);
  });

  it('rejects a storeId from a different organization (cross-tenant, I4)', async () => {
    const { storeId: storeA } = await setUpOrg();
    const { organizationId: orgB } = await setUpOrg();
    const cookieB = await issueSession(orgB);

    const response = await fetchSuggestions(storeA, cookieB);
    expect(response.statusCode).toBe(404);
  });
});

describe('purchaseOrders — create/addLine/submit/approve/reject/send/cancel (008-05)', () => {
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
      await db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, orgId));
      await db.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));

      const orgSupplierProducts = await db.select({ id: supplierProducts.id }).from(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      for (const sp of orgSupplierProducts) {
        await db.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, sp.id));
      }
      await db.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));

      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
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

  const setUpOrgWithSupplierProduct = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `PO Lifecycle Test Org ${organizationId}`,
      slug: `po-lifecycle-router-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });

    const supplierId = generateId();
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'PO Lifecycle Test Supplier' });

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();
    await db.insert(products).values({ id: productId, organizationId, sku: `PO-LIFECYCLE-${productId}`, name: 'PO Lifecycle Test Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });

    const supplierProductId = generateId();
    await db.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: 'PO-LIFECYCLE-SUP-SKU', isConfirmed: true });

    return { organizationId, storeId, supplierId, productId, supplierProductId };
  };

  /** `role`/`approvalLimit` let each test set up a real membership matching what `assertCanApprove` reads via `MembershipRepository.findByUserAndOrg` — the session alone (permissions array) is not enough for the approval-threshold path, unlike every other permission check in this router. */
  const issueSessionWithMembership = async (
    organizationId: string,
    role: 'OWNER' | 'MANAGER',
    permissions: Permission[],
    approvalLimit?: string
  ): Promise<{ token: string; userId: string }> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `po-lifecycle-${userId}@example.test` });
    await db.insert(memberships).values({
      id: generateId(),
      organizationId,
      userId,
      role,
      ...(approvalLimit !== undefined ? { approvalLimit } : {}),
      acceptedAt: new Date(),
    });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role, permissions }, '127.0.0.1', 'test-agent');
    return { token, userId };
  };

  const call = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/trpc/${path}`,
      cookies: { '__Host-session': cookie },
      payload: input,
    });

  const query = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({
      method: 'GET',
      url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
      cookies: { '__Host-session': cookie },
    });

  it('create + addLine + get: a real PO with a real line, and a real computed total', async () => {
    const { organizationId, storeId, supplierId, productId, supplierProductId } = await setUpOrgWithSupplierProduct();
    const { token } = await issueSessionWithMembership(organizationId, 'OWNER', ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const createResponse = await call('purchaseOrders.create', token, { storeId, supplierId, poNumber: 'PO-E2E-1' });
    expect(createResponse.statusCode).toBe(200);
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;

    const addLineResponse = await call('purchaseOrders.addLine', token, {
      purchaseOrderId,
      supplierProductId,
      productId,
      quantityOrderUnits: '2',
      conversionToBase: '1',
      unitPrice: '25.00',
      lineNumber: 1,
    });
    expect(addLineResponse.statusCode).toBe(200);

    const getResponse = await query('purchaseOrders.get', token, { purchaseOrderId });
    expect(getResponse.statusCode).toBe(200);
    const body = JSON.parse(getResponse.body).result.data;
    expect(body.purchaseOrder.status).toBe('DRAFT');
    expect(body.lines).toHaveLength(1);
    expect(body.total).toBe('50.0000'); // 2 * 25.00
  });

  it('a MANAGER can approve a PO within their real configured approval limit', async () => {
    const { organizationId, storeId, supplierId, productId, supplierProductId } = await setUpOrgWithSupplierProduct();
    const { token: ownerToken } = await issueSessionWithMembership(organizationId, 'OWNER', ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const createResponse = await call('purchaseOrders.create', ownerToken, { storeId, supplierId, poNumber: 'PO-E2E-2' });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;
    await call('purchaseOrders.addLine', ownerToken, { purchaseOrderId, supplierProductId, productId, quantityOrderUnits: '2', conversionToBase: '1', unitPrice: '25.00', lineNumber: 1 });
    await call('purchaseOrders.submit', ownerToken, { purchaseOrderId, expectedVersion: 1 });

    // A real MANAGER membership with a real $100 approval limit — the PO's real total is $50.00, within it.
    const { token: managerToken } = await issueSessionWithMembership(organizationId, 'MANAGER', ['purchasing:read', 'purchasing:write', 'purchasing:approve'], '100.0000');
    const approveResponse = await call('purchaseOrders.approve', managerToken, { purchaseOrderId, expectedVersion: 2 });
    expect(approveResponse.statusCode).toBe(200);
    expect(JSON.parse(approveResponse.body).result.data.newStatus).toBe('APPROVED');
  });

  it('a MANAGER is rejected (403) when the real PO total exceeds their real configured approval limit — the actual point of this task', async () => {
    const { organizationId, storeId, supplierId, productId, supplierProductId } = await setUpOrgWithSupplierProduct();
    const { token: ownerToken } = await issueSessionWithMembership(organizationId, 'OWNER', ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const createResponse = await call('purchaseOrders.create', ownerToken, { storeId, supplierId, poNumber: 'PO-E2E-3' });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;
    // A real $500 line — well above the manager's limit below.
    await call('purchaseOrders.addLine', ownerToken, { purchaseOrderId, supplierProductId, productId, quantityOrderUnits: '10', conversionToBase: '1', unitPrice: '50.00', lineNumber: 1 });
    await call('purchaseOrders.submit', ownerToken, { purchaseOrderId, expectedVersion: 1 });

    const { token: managerToken } = await issueSessionWithMembership(organizationId, 'MANAGER', ['purchasing:read', 'purchasing:write', 'purchasing:approve'], '100.0000');
    const approveResponse = await call('purchaseOrders.approve', managerToken, { purchaseOrderId, expectedVersion: 2 });
    expect(approveResponse.statusCode).toBe(403);

    // The PO must genuinely still be PENDING_APPROVAL — a rejected approval must not silently advance the state machine.
    const getResponse = await query('purchaseOrders.get', ownerToken, { purchaseOrderId });
    expect(JSON.parse(getResponse.body).result.data.purchaseOrder.status).toBe('PENDING_APPROVAL');
  });

  it('an OWNER with no configured approval limit can approve a PO of any real size — unrestricted, not zero (I7)', async () => {
    const { organizationId, storeId, supplierId, productId, supplierProductId } = await setUpOrgWithSupplierProduct();
    const { token: ownerToken } = await issueSessionWithMembership(organizationId, 'OWNER', ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const createResponse = await call('purchaseOrders.create', ownerToken, { storeId, supplierId, poNumber: 'PO-E2E-4' });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;
    await call('purchaseOrders.addLine', ownerToken, { purchaseOrderId, supplierProductId, productId, quantityOrderUnits: '1000', conversionToBase: '1', unitPrice: '50.00', lineNumber: 1 });
    await call('purchaseOrders.submit', ownerToken, { purchaseOrderId, expectedVersion: 1 });

    const approveResponse = await call('purchaseOrders.approve', ownerToken, { purchaseOrderId, expectedVersion: 2 });
    expect(approveResponse.statusCode).toBe(200);
  });

  it('approving a PO with zero lines is rejected — a $0 total must never trivially clear a threshold (I7)', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrgWithSupplierProduct();
    const { token } = await issueSessionWithMembership(organizationId, 'OWNER', ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const createResponse = await call('purchaseOrders.create', token, { storeId, supplierId, poNumber: 'PO-E2E-5' });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;
    await call('purchaseOrders.submit', token, { purchaseOrderId, expectedVersion: 1 });

    const approveResponse = await call('purchaseOrders.approve', token, { purchaseOrderId, expectedVersion: 2 });
    expect(approveResponse.statusCode).toBe(400);
  });

  it('a STAFF session (no purchasing:approve) is rejected with 403 on approve, regardless of amount', async () => {
    const { organizationId, storeId, supplierId, productId, supplierProductId } = await setUpOrgWithSupplierProduct();
    const { token: ownerToken } = await issueSessionWithMembership(organizationId, 'OWNER', ['purchasing:read', 'purchasing:write', 'purchasing:approve']);
    const createResponse = await call('purchaseOrders.create', ownerToken, { storeId, supplierId, poNumber: 'PO-E2E-6' });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;
    await call('purchaseOrders.addLine', ownerToken, { purchaseOrderId, supplierProductId, productId, quantityOrderUnits: '1', conversionToBase: '1', unitPrice: '5.00', lineNumber: 1 });
    await call('purchaseOrders.submit', ownerToken, { purchaseOrderId, expectedVersion: 1 });

    const staffUserId = generateId();
    createdUserIds.push(staffUserId);
    const { token: staffToken } = await sessionStore.create(
      { userId: staffUserId, organizationId, storeIds: 'ALL', role: 'STAFF', permissions: ['inventory:read', 'inventory:write', 'inventory:adjust'] },
      '127.0.0.1',
      'test-agent'
    );
    const approveResponse = await call('purchaseOrders.approve', staffToken, { purchaseOrderId, expectedVersion: 2 });
    expect(approveResponse.statusCode).toBe(403);
  });

  it('a stale expectedVersion on submit returns a real 409, not a silent success', async () => {
    const { organizationId, storeId, supplierId } = await setUpOrgWithSupplierProduct();
    const { token } = await issueSessionWithMembership(organizationId, 'OWNER', ['purchasing:read', 'purchasing:write', 'purchasing:approve']);
    const createResponse = await call('purchaseOrders.create', token, { storeId, supplierId, poNumber: 'PO-E2E-7' });
    const purchaseOrderId = JSON.parse(createResponse.body).result.data.id;

    await call('purchaseOrders.submit', token, { purchaseOrderId, expectedVersion: 1 });
    const staleSubmit = await call('purchaseOrders.submit', token, { purchaseOrderId, expectedVersion: 1 });
    expect(staleSubmit.statusCode).toBe(409);
  });
});
