import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { notificationDeliveries, notificationRules, notifications } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { NotificationDeliveryRepository, NotificationRepository, NotificationRuleRepository } from './notification-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('NotificationRuleRepository / NotificationRepository / NotificationDeliveryRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let fixture: TwoTenantFixture;

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    // Child-then-parent delete order (the recurring FK-teardown-order class): deliveries before
    // notifications before rules.
    await adminDb.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, fixture.tenantB.organizationId));
    await adminDb.delete(notifications).where(eq(notifications.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(notifications).where(eq(notifications.organizationId, fixture.tenantB.organizationId));
    await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, fixture.tenantB.organizationId));
    await client.end();
    await fixture.cleanup();
  });

  it('NotificationRuleRepository: create writes a real row, findById reads it back, findEnabledByType filters correctly', async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);

    const db = createScopedDb(client);
    const repo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);

    const { id } = await repo.create({
      storeId: fixture.tenantA.storeId,
      ruleType: 'stock_below_reorder',
      threshold: { quantity: 5 },
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const found = await repo.findById(id);
    expect(found?.ruleType).toBe('stock_below_reorder');
    expect(found?.enabled).toBe(true);
    expect(found?.severity).toBe('HIGH');

    const enabled = await repo.findEnabledByType('stock_below_reorder');
    expect(enabled.map((r) => r.id)).toContain(id);

    const wrongType = await repo.findEnabledByType('lot_expiring');
    expect(wrongType.map((r) => r.id)).not.toContain(id);
  });

  it('a disabled rule is excluded from findEnabledByType, not just hidden by client filtering', async () => {
    const db = createScopedDb(client);
    const repo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);

    const { id } = await repo.create({
      ruleType: 'lot_expiring',
      enabled: false,
      threshold: { days: 2 },
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const found = await repo.findById(id);
    expect(found?.enabled).toBe(false);

    const enabled = await repo.findEnabledByType('lot_expiring');
    expect(enabled.map((r) => r.id)).not.toContain(id);
  });

  it('a cross-tenant rule is genuinely invisible, not just filtered client-side', async () => {
    const dbA = createScopedDb(client);
    const repoA = new NotificationRuleRepository(dbA, fixture.tenantA.organizationId);
    const { id } = await repoA.create({
      ruleType: 'stock_below_reorder',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const repoB = new NotificationRuleRepository(dbA, fixture.tenantB.organizationId);
    const found = await repoB.findById(id);

    expect(found).toBeNull();
  });

  it('NotificationRepository: create writes a real row, findById reads it back, markResolved/markActed set real timestamps', async () => {
    const db = createScopedDb(client);
    const ruleRepo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);
    const { id: ruleId } = await ruleRepo.create({
      storeId: fixture.tenantA.storeId,
      ruleType: 'lot_expiring',
      threshold: { days: 2 },
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const repo = new NotificationRepository(db, fixture.tenantA.organizationId);
    const { id } = await repo.create({
      storeId: fixture.tenantA.storeId,
      ruleId,
      severity: 'HIGH',
      title: 'Cream expiring',
      body: '12kg cream expires in 2 days',
      dedupKey: `expiry:${fixture.tenantA.storeId}:2026-08-20`,
      dollarImpact: '340.00',
    });

    const found = await repo.findById(id);
    expect(found?.title).toBe('Cream expiring');
    expect(found?.dollarImpact).toBe('340.0000');
    expect(found?.resolvedAt).toBeNull();
    expect(found?.actedAt).toBeNull();

    await repo.markActed(id);
    const acted = await repo.findById(id);
    expect(acted?.actedAt).not.toBeNull();
    expect(acted?.resolvedAt).toBeNull();

    await repo.markResolved(id);
    const resolved = await repo.findById(id);
    expect(resolved?.resolvedAt).not.toBeNull();

    const unresolved = await repo.findUnresolvedForStore(fixture.tenantA.storeId);
    expect(unresolved.map((n) => n.id)).not.toContain(id);
  });

  it('markRead sets readAt idempotently, countUnreadForStore reflects it, and an org-wide notification counts for every store', async () => {
    const db = createScopedDb(client);
    const ruleRepo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);
    const { id: ruleId } = await ruleRepo.create({
      ruleType: 'stock_below_reorder',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const repo = new NotificationRepository(db, fixture.tenantA.organizationId);
    const { id: storeSpecificId } = await repo.create({
      storeId: fixture.tenantA.storeId,
      ruleId,
      severity: 'HIGH',
      title: 'Store-specific',
      body: 'body',
      dedupKey: `readtest-store:${generateId()}`,
    });
    const { id: orgWideId } = await repo.create({
      ruleId,
      severity: 'HIGH',
      title: 'Org-wide',
      body: 'body',
      dedupKey: `readtest-orgwide:${generateId()}`,
    });

    // Both a store-specific AND an org-wide (storeId: null) notification count toward this store's
    // unread total — matching notification_rules.storeId's own "null means every store" semantics.
    expect(await repo.countUnreadForStore(fixture.tenantA.storeId)).toBe(2);

    const unresolvedForStore = await repo.findUnresolvedForStore(fixture.tenantA.storeId);
    expect(unresolvedForStore.map((n) => n.id)).toContain(storeSpecificId);
    expect(unresolvedForStore.map((n) => n.id)).toContain(orgWideId);

    await repo.markRead(storeSpecificId);
    const afterRead = await repo.findById(storeSpecificId);
    expect(afterRead?.readAt).not.toBeNull();
    expect(await repo.countUnreadForStore(fixture.tenantA.storeId)).toBe(1); // only the org-wide one remains unread

    // A second markRead is a genuine no-op — the FIRST real readAt timestamp is preserved, never overwritten.
    const firstReadAt = afterRead!.readAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await repo.markRead(storeSpecificId);
    const afterSecondMarkRead = await repo.findById(storeSpecificId);
    expect(afterSecondMarkRead?.readAt?.getTime()).toBe(firstReadAt?.getTime());

    // A read notification is STILL unresolved and still shows in the list — read and resolved are
    // genuinely different facts.
    const stillListed = await repo.findUnresolvedForStore(fixture.tenantA.storeId);
    expect(stillListed.map((n) => n.id)).toContain(storeSpecificId);
  });

  it('a second open notification with the same dedupKey is rejected by the real partial unique index, not silently duplicated', async () => {
    const db = createScopedDb(client);
    const ruleRepo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);
    const { id: ruleId } = await ruleRepo.create({
      ruleType: 'lot_expiring',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const repo = new NotificationRepository(db, fixture.tenantA.organizationId);
    const dedupKey = `expiry:${fixture.tenantA.storeId}:dedup-test`;
    await repo.create({ ruleId, severity: 'HIGH', title: 'First', body: 'First body', dedupKey });

    await expect(
      repo.create({ ruleId, severity: 'HIGH', title: 'Second', body: 'Second body', dedupKey })
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('a cross-tenant notification is genuinely invisible, not just filtered client-side', async () => {
    const dbA = createScopedDb(client);
    const ruleRepoA = new NotificationRuleRepository(dbA, fixture.tenantA.organizationId);
    const { id: ruleId } = await ruleRepoA.create({
      ruleType: 'lot_expiring',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const repoA = new NotificationRepository(dbA, fixture.tenantA.organizationId);
    const { id } = await repoA.create({
      ruleId,
      severity: 'HIGH',
      title: 'Tenant A only',
      body: 'body',
      dedupKey: `expiry:${fixture.tenantA.storeId}:cross-tenant-test`,
    });

    const repoB = new NotificationRepository(dbA, fixture.tenantB.organizationId);
    const found = await repoB.findById(id);

    expect(found).toBeNull();
  });

  it('NotificationDeliveryRepository: create writes a real row, findPending/findForUser/markDelivered/markOpened all work against real data', async () => {
    const db = createScopedDb(client);
    const ruleRepo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);
    const { id: ruleId } = await ruleRepo.create({
      ruleType: 'lot_expiring',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const notificationRepo = new NotificationRepository(db, fixture.tenantA.organizationId);
    const { id: notificationId } = await notificationRepo.create({
      ruleId,
      severity: 'HIGH',
      title: 'Delivery test',
      body: 'body',
      dedupKey: `expiry:${fixture.tenantA.storeId}:delivery-test`,
    });

    const repo = new NotificationDeliveryRepository(db, fixture.tenantA.organizationId);
    const { id } = await repo.create({ notificationId, userId: fixture.tenantA.userId, channel: 'EMAIL' });

    const pendingBefore = await repo.findPending();
    expect(pendingBefore.map((d) => d.id)).toContain(id);

    const forUser = await repo.findForUser(fixture.tenantA.userId);
    expect(forUser.map((d) => d.id)).toContain(id);

    await repo.markDelivered(id);
    const pendingAfter = await repo.findPending();
    expect(pendingAfter.map((d) => d.id)).not.toContain(id);

    await repo.markOpened(id);
    const opened = (await repo.findForUser(fixture.tenantA.userId)).find((d) => d.id === id);
    expect(opened?.openedAt).not.toBeNull();
    expect(opened?.status).toBe('DELIVERED');
  });

  it('a cross-tenant delivery is genuinely invisible, not just filtered client-side', async () => {
    const dbA = createScopedDb(client);
    const ruleRepoA = new NotificationRuleRepository(dbA, fixture.tenantA.organizationId);
    const { id: ruleId } = await ruleRepoA.create({
      ruleType: 'lot_expiring',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const notificationRepoA = new NotificationRepository(dbA, fixture.tenantA.organizationId);
    const { id: notificationId } = await notificationRepoA.create({
      ruleId,
      severity: 'HIGH',
      title: 'Cross-tenant delivery test',
      body: 'body',
      dedupKey: `expiry:${fixture.tenantA.storeId}:delivery-cross-tenant`,
    });
    const deliveryRepoA = new NotificationDeliveryRepository(dbA, fixture.tenantA.organizationId);
    const { id } = await deliveryRepoA.create({ notificationId, userId: fixture.tenantA.userId, channel: 'EMAIL' });

    const deliveryRepoB = new NotificationDeliveryRepository(dbA, fixture.tenantB.organizationId);
    const found = (await deliveryRepoB.findForUser(fixture.tenantA.userId)).find((d) => d.id === id);

    expect(found).toBeUndefined();
  });
});
