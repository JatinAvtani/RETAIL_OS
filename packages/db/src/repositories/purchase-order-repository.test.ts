import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { auditLogs, organizations, outboxEvents, products, purchaseOrderLines, purchaseOrders, stores, suppliers, supplierProducts, units, users } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { PurchaseOrderRepository } from './purchase-order-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('PurchaseOrderRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let supplierId: string;
  let productId: string;
  let supplierProductId: string;
  let kgUnitId: string;
  let actorUserId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'PO Repo Test Org',
      slug: `po-repo-test-${organizationId}`,
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
      sku: 'PO-TEST-SKU',
      name: 'PO Test Product',
      baseUnitId: kgUnitId,
      type: 'INGREDIENT',
    });

    supplierProductId = generateId();
    await adminDb.insert(supplierProducts).values({
      id: supplierProductId,
      organizationId,
      supplierId,
      productId,
      supplierSku: 'SUP-SKU-PO-TEST',
    });

    actorUserId = generateId();
    await adminDb.insert(users).values({ id: actorUserId, email: `po-repo-test-${actorUserId}@example.test` });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    // FK order: outbox_events/audit_logs (real rows now that create/applyTransition emit them,
    // I8) before purchase_order_lines before purchase_orders (child before parent).
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, organizationId));
    await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, organizationId));
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(users).where(eq(users.id, actorUserId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('create records a new purchase order in DRAFT status with version 1', async () => {
    const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, supplierId, poNumber: 'PO-1001', currency: 'USD' });

    const row = await repo.findById(created.id);
    expect(row?.status).toBe('DRAFT');
    expect(row?.version).toBe(1);
    expect(row?.poNumber).toBe('PO-1001');
  });

  it('create writes a real po.created outbox event and, when an actor is given, a real audit log entry (I8)', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, supplierId, poNumber: 'PO-1004', currency: 'USD', createdByUserId: actorUserId });

    const events = await adminDb
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, created.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('po.created');
    expect(events[0]?.aggregateType).toBe('purchase_order');

    const logs = await adminDb.select().from(auditLogs).where(eq(auditLogs.entityId, created.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.action).toBe('purchase_order.created');
    expect(logs[0]?.actorUserId).toBe(actorUserId);
  });

  it('create writes no audit log entry when no actor is given, but still writes the outbox event', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, supplierId, poNumber: 'PO-1005', currency: 'USD' });

    const events = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, created.id));
    expect(events).toHaveLength(1);

    const logs = await adminDb.select().from(auditLogs).where(eq(auditLogs.entityId, created.id));
    expect(logs).toHaveLength(0);
  });

  it('addLine computes quantityBaseUnits and lineTotal from the stored conversion factor, never trusting a caller-supplied total', async () => {
    const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, supplierId, poNumber: 'PO-1002', currency: 'USD' });

    const result = await repo.addLine({
      purchaseOrderId: created.id,
      supplierProductId,
      productId,
      quantityOrderUnits: '3',
      conversionToBase: '12',
      unitPrice: '20.00',
      lineNumber: 1,
    });
    expect(result.ok).toBe(true);

    const lines = await repo.findLines(created.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantityBaseUnits).toBe('36.000000'); // 3 * 12, numeric(19,6) scale
    expect(lines[0]?.lineTotal).toBe('60.0000'); // 3 * 20.00
  });

  it('getTotal sums every line\'s real lineTotal, never a caller-supplied figure', async () => {
    const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, supplierId, poNumber: 'PO-1006', currency: 'USD' });
    await repo.addLine({ purchaseOrderId: created.id, supplierProductId, productId, quantityOrderUnits: '2', conversionToBase: '1', unitPrice: '10.00', lineNumber: 1 });
    await repo.addLine({ purchaseOrderId: created.id, supplierProductId, productId, quantityOrderUnits: '3', conversionToBase: '1', unitPrice: '5.00', lineNumber: 2 });

    const total = await repo.getTotal(created.id);
    expect(total).toBe('35.0000'); // (2*10.00) + (3*5.00) = 20 + 15 = 35
  });

  it('getTotal returns null (never a fabricated 0) for a purchase order with zero lines — I7', async () => {
    const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, supplierId, poNumber: 'PO-1007', currency: 'USD' });

    const total = await repo.getTotal(created.id);
    expect(total).toBeNull();
  });

  it('addLine refuses to add a line to a non-DRAFT purchase order', async () => {
    const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, supplierId, poNumber: 'PO-1003', currency: 'USD' });
    const row = await repo.findById(created.id);

    const submitResult = await repo.applyTransition(created.id, 'SUBMIT', row!.version);
    expect(submitResult.ok).toBe(true);

    const result = await repo.addLine({
      purchaseOrderId: created.id,
      supplierProductId,
      productId,
      quantityOrderUnits: '1',
      conversionToBase: '1',
      unitPrice: '10.00',
      lineNumber: 1,
    });
    expect(result).toEqual({ ok: false, reason: 'NOT_EDITABLE' });
  });

  it('addLine returns NOT_FOUND (not NOT_EDITABLE) for a purchase order that does not exist at all', async () => {
    const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
    const result = await repo.addLine({
      purchaseOrderId: generateId(),
      supplierProductId,
      productId,
      quantityOrderUnits: '1',
      conversionToBase: '1',
      unitPrice: '10.00',
      lineNumber: 1,
    });
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  describe('applyTransition — the real database round trip through the domain state machine', () => {
    it('DRAFT -> SUBMIT -> PENDING_APPROVAL, version incremented, submittedAt/submittedByUserId recorded', async () => {
      const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const created = await repo.create({ storeId, supplierId, poNumber: 'PO-2001', currency: 'USD' });

      const result = await repo.applyTransition(created.id, 'SUBMIT', 1, actorUserId);
      expect(result).toEqual({ ok: true, newStatus: 'PENDING_APPROVAL' });

      const row = await repo.findById(created.id);
      expect(row?.status).toBe('PENDING_APPROVAL');
      expect(row?.version).toBe(2);
      expect(row?.submittedAt).not.toBeNull();
      expect(row?.submittedByUserId).toBe(actorUserId);
    });

    it('applyTransition writes a real po.submitted outbox event and audit log entry in the same transaction as the status change (I8)', async () => {
      const adminDb = drizzle(adminClient, { schema });
      const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const created = await repo.create({ storeId, supplierId, poNumber: 'PO-2007', currency: 'USD' });

      await repo.applyTransition(created.id, 'SUBMIT', 1, actorUserId);

      const events = await adminDb
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, created.id));
      // One po.created (from create()) + one po.submitted (from applyTransition) — both real rows.
      expect(events.map((e) => e.eventType).sort()).toEqual(['po.created', 'po.submitted']);

      const logs = await adminDb.select().from(auditLogs).where(eq(auditLogs.entityId, created.id));
      const submittedLog = logs.find((l) => l.action === 'purchase_order.submitted');
      expect(submittedLog).toBeDefined();
      expect(submittedLog?.actorUserId).toBe(actorUserId);
    });

    it('an illegal transition never writes an outbox event or audit log entry — only a real state change is recorded', async () => {
      const adminDb = drizzle(adminClient, { schema });
      const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const created = await repo.create({ storeId, supplierId, poNumber: 'PO-2008', currency: 'USD' });

      const beforeEvents = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, created.id));
      const rejectResult = await repo.applyTransition(created.id, 'SEND', 1, actorUserId);
      expect(rejectResult.ok).toBe(false);

      const afterEvents = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, created.id));
      expect(afterEvents).toHaveLength(beforeEvents.length); // only the create()-time po.created, nothing new
    });

    it('an illegal transition is rejected with a reason, and the row is left completely unchanged', async () => {
      const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const created = await repo.create({ storeId, supplierId, poNumber: 'PO-2002', currency: 'USD' });

      const result = await repo.applyTransition(created.id, 'SEND', 1);
      expect(result.ok).toBe(false);

      const row = await repo.findById(created.id);
      expect(row?.status).toBe('DRAFT');
      expect(row?.version).toBe(1);
    });

    it('a stale expectedVersion is rejected — the real optimistic-lock proof, not just a unit-level assumption', async () => {
      const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const created = await repo.create({ storeId, supplierId, poNumber: 'PO-2003', currency: 'USD' });

      // First caller succeeds and bumps version to 2.
      const first = await repo.applyTransition(created.id, 'SUBMIT', 1);
      expect(first.ok).toBe(true);

      // A second caller still holding the stale version=1 view attempts the same transition.
      const second = await repo.applyTransition(created.id, 'APPROVE', 1);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.reason).toMatch(/concurrently/);
      }

      // The row still reflects only the first, successful transition.
      const row = await repo.findById(created.id);
      expect(row?.status).toBe('PENDING_APPROVAL');
      expect(row?.version).toBe(2);
    });

    it('the full happy path to SENT records every actor/timestamp pair independently', async () => {
      const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const created = await repo.create({ storeId, supplierId, poNumber: 'PO-2004', currency: 'USD' });
      const adminDb = drizzle(adminClient, { schema });
      const submitter = generateId();
      const approver = generateId();
      const sender = generateId();
      await adminDb.insert(users).values([
        { id: submitter, email: `submitter-${submitter}@example.test` },
        { id: approver, email: `approver-${approver}@example.test` },
        { id: sender, email: `sender-${sender}@example.test` },
      ]);

      await repo.applyTransition(created.id, 'SUBMIT', 1, submitter);
      await repo.applyTransition(created.id, 'APPROVE', 2, approver);
      const sendResult = await repo.applyTransition(created.id, 'SEND', 3, sender);
      expect(sendResult).toEqual({ ok: true, newStatus: 'SENT' });

      const row = await repo.findById(created.id);
      expect(row?.status).toBe('SENT');
      expect(row?.submittedByUserId).toBe(submitter);
      expect(row?.approvedByUserId).toBe(approver);
      expect(row?.sentByUserId).toBe(sender);
      expect(row?.version).toBe(4);

      // Delete this test's own audit_logs/purchase_order rows FIRST — audit_logs.actorUserId AND
      // purchase_orders' submitted/approved/sent_by_user_id columns all reference these three
      // users via FK, so both must go before the users themselves, not after. outbox_events has no
      // user FK (aggregateId is a plain uuid) but is cleaned up here too for tidiness. The shared
      // afterEach hook still runs afterward and finds nothing left to delete for this PO, harmless.
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.aggregateId, created.id));
      await adminDb.delete(auditLogs).where(eq(auditLogs.entityId, created.id));
      await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.id, created.id));
      await adminDb.delete(users).where(eq(users.id, submitter));
      await adminDb.delete(users).where(eq(users.id, approver));
      await adminDb.delete(users).where(eq(users.id, sender));
    });

    it('REJECT returns a PENDING_APPROVAL order to DRAFT and records a rejection reason', async () => {
      const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const created = await repo.create({ storeId, supplierId, poNumber: 'PO-2005', currency: 'USD' });
      await repo.applyTransition(created.id, 'SUBMIT', 1);

      const result = await repo.applyTransition(created.id, 'REJECT', 2, actorUserId, 'Missing line-item pricing');
      expect(result).toEqual({ ok: true, newStatus: 'DRAFT' });

      const row = await repo.findById(created.id);
      expect(row?.status).toBe('DRAFT');
      expect(row?.rejectedByUserId).toBe(actorUserId);
      expect(row?.rejectionReason).toBe('Missing line-item pricing');
    });

    it('CANCEL is rejected once a purchase order has reached PARTIALLY_RECEIVED, matching the domain state machine exactly', async () => {
      const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const created = await repo.create({ storeId, supplierId, poNumber: 'PO-2006', currency: 'USD' });
      await repo.applyTransition(created.id, 'SUBMIT', 1);
      await repo.applyTransition(created.id, 'APPROVE', 2);
      await repo.applyTransition(created.id, 'SEND', 3);
      await repo.applyTransition(created.id, 'RECEIVE_PARTIAL', 4);

      const cancelResult = await repo.applyTransition(created.id, 'CANCEL', 5);
      expect(cancelResult.ok).toBe(false);

      const row = await repo.findById(created.id);
      expect(row?.status).toBe('PARTIALLY_RECEIVED');
    });

    it('applyTransition on a nonexistent purchase order returns a not-found result, never throws', async () => {
      const repo = new PurchaseOrderRepository(createScopedDb(client), organizationId);
      const result = await repo.applyTransition(generateId(), 'SUBMIT', 1);
      expect(result).toEqual({ ok: false, reason: 'Purchase order not found.' });
    });
  });

  describe('cross-tenant isolation (I4)', () => {
    let fixture: TwoTenantFixture;

    afterEach(async () => {
      await fixture?.cleanup();
    });

    it('a purchase order created under tenant A is invisible to tenant B, even by direct id', async () => {
      fixture = await setUpTwoTenants();
      const repoA = new PurchaseOrderRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const repoB = new PurchaseOrderRepository(createScopedDb(client), fixture.tenantB.organizationId);

      const supplierIdA = generateId();
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.insert(suppliers).values({ id: supplierIdA, organizationId: fixture.tenantA.organizationId, name: 'Tenant A Supplier' });

      const created = await repoA.create({
        storeId: fixture.tenantA.storeId,
        supplierId: supplierIdA,
        poNumber: 'PO-CROSS-1',
        currency: 'USD',
      });

      const fromB = await repoB.findById(created.id);
      expect(fromB).toBeNull();

      const attackResult = await repoB.applyTransition(created.id, 'SUBMIT', 1);
      expect(attackResult).toEqual({ ok: false, reason: 'Purchase order not found.' });

      // outbox_events references organizations directly (aggregateId is a plain uuid, no FK to
      // purchase_orders itself, but organizationId IS a real FK) — must be cleaned up before
      // fixture.cleanup() deletes both tenants' organization rows.
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(suppliers).where(eq(suppliers.id, supplierIdA));
    });
  });
});
