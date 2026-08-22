import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { notificationDeliveries, notificationRules, notifications, notificationPreferences } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { NotificationDeliveryRepository, NotificationPreferenceRepository, NotificationRepository, NotificationRuleRepository } from './notification-repository';
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
    await adminDb.delete(notificationPreferences).where(eq(notificationPreferences.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(notificationPreferences).where(eq(notificationPreferences.organizationId, fixture.tenantB.organizationId));
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

  it('findAll returns every real rule for this org regardless of type/enabled state, and is genuinely tenant-scoped', async () => {
    const db = createScopedDb(client);
    const repoA = new NotificationRuleRepository(db, fixture.tenantA.organizationId);
    const { id: enabledId } = await repoA.create({
      ruleType: 'findall_test_enabled',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const { id: disabledId } = await repoA.create({
      ruleType: 'findall_test_disabled',
      enabled: false,
      threshold: {},
      severity: 'MEDIUM',
      recipientRoles: ['OWNER'],
      channels: [],
    });

    const allA = await repoA.findAll();
    const idsA = allA.map((r) => r.id);
    expect(idsA).toContain(enabledId);
    expect(idsA).toContain(disabledId); // disabled rows are still real configuration, not hidden from this read path

    const repoB = new NotificationRuleRepository(db, fixture.tenantB.organizationId);
    const allB = await repoB.findAll();
    expect(allB.map((r) => r.id)).not.toContain(enabledId);
  });

  it('updateTuning writes real severity/recipientRoles/channels changes and leaves threshold untouched', async () => {
    const db = createScopedDb(client);
    const repo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);
    const { id } = await repo.create({
      ruleType: 'update_tuning_test',
      threshold: { withinDays: 3 },
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    await repo.updateTuning(id, { severity: 'MEDIUM', recipientRoles: ['OWNER', 'MANAGER'], channels: [] });

    const updated = await repo.findById(id);
    expect(updated?.severity).toBe('MEDIUM');
    expect(updated?.recipientRoles).toEqual(['OWNER', 'MANAGER']);
    expect(updated?.channels).toEqual([]);
    // threshold is deliberately NOT part of updateTuning's input — proves it survives untouched.
    expect(updated?.threshold).toEqual({ withinDays: 3 });
  });

  it('updateTuning on a cross-tenant rule id genuinely fails to affect it, not just returns silently', async () => {
    const dbA = createScopedDb(client);
    const repoA = new NotificationRuleRepository(dbA, fixture.tenantA.organizationId);
    const { id } = await repoA.create({
      ruleType: 'cross_tenant_update_test',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const repoB = new NotificationRuleRepository(dbA, fixture.tenantB.organizationId);
    await repoB.updateTuning(id, { severity: 'CRITICAL', recipientRoles: ['STAFF'], channels: [] });

    const stillA = await repoA.findById(id);
    expect(stillA?.severity).toBe('HIGH'); // tenant B's update genuinely affected zero rows
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

  it('NotificationDeliveryRepository: markFailed increments attempts and records the real error, markDeadLettered sets the terminal status', async () => {
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
      title: 'Retry/DLQ test',
      body: 'body',
      dedupKey: `expiry:${fixture.tenantA.storeId}:retry-dlq-test`,
    });

    const repo = new NotificationDeliveryRepository(db, fixture.tenantA.organizationId);
    const { id } = await repo.create({ notificationId, userId: fixture.tenantA.userId, channel: 'EMAIL' });

    await repo.markFailed(id, 'Simulated transient delivery failure');
    const afterFirstFailure = await repo.findById(id);
    expect(afterFirstFailure?.status).toBe('FAILED');
    expect(afterFirstFailure?.attempts).toBe(1);
    expect(afterFirstFailure?.error).toBe('Simulated transient delivery failure');

    await repo.markFailed(id, 'Second simulated failure');
    const afterSecondFailure = await repo.findById(id);
    expect(afterSecondFailure?.attempts).toBe(2); // increments, never resets
    expect(afterSecondFailure?.error).toBe('Second simulated failure'); // holds the MOST RECENT reason, not accumulated

    await repo.markDeadLettered(id, 'Exhausted all retry attempts');
    const deadLettered = await repo.findById(id);
    expect(deadLettered?.status).toBe('DEAD_LETTERED');
    expect(deadLettered?.attempts).toBe(3);
    expect(deadLettered?.error).toBe('Exhausted all retry attempts');

    // A dead-lettered delivery is no longer PENDING — the retry/DLQ scan must not keep re-queuing it.
    const pending = await repo.findPending();
    expect(pending.map((d) => d.id)).not.toContain(id);
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

  it('findActionTrackingRowsSince: a notification with no delivery still produces one row (deliveryId null), a notification with two deliveries produces two rows sharing the same notificationId/actedAt, and a notification older than `since` is excluded', async () => {
    const db = createScopedDb(client);
    const ruleRepo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);
    const { id: ruleId } = await ruleRepo.create({
      ruleType: 'action_tracking_test_type',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const notificationRepo = new NotificationRepository(db, fixture.tenantA.organizationId);

    // No-delivery notification, acted on.
    const { id: noDeliveryId } = await notificationRepo.create({
      ruleId,
      severity: 'HIGH',
      title: 'No delivery',
      body: 'body',
      dedupKey: `action-tracking:no-delivery:${generateId()}`,
    });
    await notificationRepo.markActed(noDeliveryId);

    // Two-delivery notification, one delivered+opened, one only delivered.
    const { id: twoDeliveryId } = await notificationRepo.create({
      ruleId,
      severity: 'HIGH',
      title: 'Two deliveries',
      body: 'body',
      dedupKey: `action-tracking:two-delivery:${generateId()}`,
    });
    const deliveryRepo = new NotificationDeliveryRepository(db, fixture.tenantA.organizationId);
    const { id: delivery1 } = await deliveryRepo.create({ notificationId: twoDeliveryId, userId: fixture.tenantA.userId, channel: 'EMAIL' });
    await deliveryRepo.markDelivered(delivery1);
    await deliveryRepo.markOpened(delivery1);
    const { id: delivery2 } = await deliveryRepo.create({ notificationId: twoDeliveryId, userId: fixture.tenantA.userId, channel: 'EMAIL' });
    await deliveryRepo.markDelivered(delivery2);

    const since = new Date(Date.now() - 60_000);
    const rows = await notificationRepo.findActionTrackingRowsSince(since);
    const relevant = rows.filter((r) => r.notificationId === noDeliveryId || r.notificationId === twoDeliveryId);

    const noDeliveryRows = relevant.filter((r) => r.notificationId === noDeliveryId);
    expect(noDeliveryRows).toHaveLength(1);
    expect(noDeliveryRows[0]?.deliveryId).toBeNull();
    expect(noDeliveryRows[0]?.actedAt).not.toBeNull();
    expect(noDeliveryRows[0]?.ruleType).toBe('action_tracking_test_type');

    const twoDeliveryRows = relevant.filter((r) => r.notificationId === twoDeliveryId);
    expect(twoDeliveryRows).toHaveLength(2);
    expect(twoDeliveryRows.every((r) => r.actedAt === null)).toBe(true);
    const opened = twoDeliveryRows.find((r) => r.deliveryId === delivery1);
    const deliveredOnly = twoDeliveryRows.find((r) => r.deliveryId === delivery2);
    expect(opened?.openedAt).not.toBeNull();
    expect(deliveredOnly?.openedAt).toBeNull();
    expect(deliveredOnly?.deliveredAt).not.toBeNull();

    // A `since` in the future excludes both — proves the window is real, not accidentally unbounded.
    const future = new Date(Date.now() + 60_000);
    const noneAfterFuture = (await notificationRepo.findActionTrackingRowsSince(future)).filter(
      (r) => r.notificationId === noDeliveryId || r.notificationId === twoDeliveryId
    );
    expect(noneAfterFuture).toHaveLength(0);
  });

  it('findActionTrackingRowsSince is genuinely tenant-scoped — tenant B never sees tenant A\'s rows', async () => {
    const dbA = createScopedDb(client);
    const ruleRepoA = new NotificationRuleRepository(dbA, fixture.tenantA.organizationId);
    const { id: ruleId } = await ruleRepoA.create({
      ruleType: 'action_tracking_cross_tenant_type',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const notificationRepoA = new NotificationRepository(dbA, fixture.tenantA.organizationId);
    await notificationRepoA.create({
      ruleId,
      severity: 'HIGH',
      title: 'Tenant A only',
      body: 'body',
      dedupKey: `action-tracking:cross-tenant:${generateId()}`,
    });

    const notificationRepoB = new NotificationRepository(dbA, fixture.tenantB.organizationId);
    const rowsB = await notificationRepoB.findActionTrackingRowsSince(new Date(Date.now() - 60_000));
    expect(rowsB.some((r) => r.ruleType === 'action_tracking_cross_tenant_type')).toBe(false);
  });

  it('NotificationPreferenceRepository: findForUser/findOrDefaultForUser/upsertForUser all work against real data', async () => {
    const db = createScopedDb(client);
    const repo = new NotificationPreferenceRepository(db, fixture.tenantA.organizationId);

    // No row yet — findForUser returns null, findOrDefaultForUser returns the real documented default.
    expect(await repo.findForUser(fixture.tenantA.userId)).toBeNull();
    expect(await repo.findOrDefaultForUser(fixture.tenantA.userId)).toEqual({
      mutedChannels: [],
      quietHoursStartHour: null,
      quietHoursEndHour: null,
      criticalOverridesQuietHours: true,
    });

    const { id: firstId } = await repo.upsertForUser(fixture.tenantA.userId, {
      mutedChannels: ['SMS'],
      quietHoursStartHour: 22,
      quietHoursEndHour: 7,
      criticalOverridesQuietHours: false,
    });

    const afterFirstUpsert = await repo.findOrDefaultForUser(fixture.tenantA.userId);
    expect(afterFirstUpsert).toEqual({
      mutedChannels: ['SMS'],
      quietHoursStartHour: 22,
      quietHoursEndHour: 7,
      criticalOverridesQuietHours: false,
    });

    // A SECOND upsert for the SAME user overwrites in place — same row id, new values win, never a second row.
    const { id: secondId } = await repo.upsertForUser(fixture.tenantA.userId, {
      mutedChannels: [],
      quietHoursStartHour: 9,
      quietHoursEndHour: 17,
      criticalOverridesQuietHours: true,
    });
    expect(secondId).toBe(firstId);

    const afterSecondUpsert = await repo.findOrDefaultForUser(fixture.tenantA.userId);
    expect(afterSecondUpsert).toEqual({
      mutedChannels: [],
      quietHoursStartHour: 9,
      quietHoursEndHour: 17,
      criticalOverridesQuietHours: true,
    });
  });

  it('a cross-tenant preference is genuinely invisible — a tenant B repository never sees tenant A\'s row', async () => {
    const dbA = createScopedDb(client);
    const repoA = new NotificationPreferenceRepository(dbA, fixture.tenantA.organizationId);
    await repoA.upsertForUser(fixture.tenantA.userId, {
      mutedChannels: ['SMS'],
      quietHoursStartHour: 22,
      quietHoursEndHour: 7,
      criticalOverridesQuietHours: true,
    });

    const repoB = new NotificationPreferenceRepository(dbA, fixture.tenantB.organizationId);
    // tenant A's real userId, queried through a TENANT B-scoped repository — RLS must hide it.
    expect(await repoB.findForUser(fixture.tenantA.userId)).toBeNull();
  });
});
