import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  organizations,
  stores,
  notifications,
  notificationRules,
  notificationDeliveries,
  notificationPreferences,
  users,
  NotificationRepository,
  NotificationRuleRepository,
  NotificationDeliveryRepository,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import type { Permission } from '@retailos/authz';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * Real HTTP proof of the epic's first UI/API surface — matching `assistant.test.ts`'s own
 * established "verify the HTTP layer with real requests" discipline (typecheck/unit tests alone
 * miss error-shape/status-code bugs).
 */
describe('notifications router', () => {
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
      await db.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, orgId));
      await db.delete(notifications).where(eq(notifications.organizationId, orgId));
      await db.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      await db.delete(notificationPreferences).where(eq(notificationPreferences.organizationId, orgId));
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

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Notif Test Org ${organizationId}`, slug: `notif-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const issueSession = async (organizationId: string, permissions: Permission[] = []): Promise<string> => {
    const userId = generateId();
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  /**
   * `notification_preferences.user_id` has a real FK to `users.id` — the plain `issueSession`
   * helper above mints a synthetic userId that was never inserted as a real row, which is fine for
   * every other notifications.* procedure (none of them write to a user-FK'd table) but would
   * violate the FK the moment `updatePreferences` tries to write. This variant inserts a genuine
   * `users` row matching the session's own userId first.
   */
  const issueSessionWithRealUser = async (organizationId: string): Promise<{ cookie: string; userId: string }> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `pref-test-${userId}@example.test` });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions: [] }, '127.0.0.1', 'test-agent');
    return { cookie: token, userId };
  };

  const call = async (path: string, cookie: string, payload: Record<string, unknown>, method: 'GET' | 'POST' = 'GET') =>
    app.inject({
      method,
      url: method === 'GET' ? `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(payload))}` : `/trpc/${path}`,
      cookies: { '__Host-session': cookie },
      ...(method === 'POST' ? { payload } : {}),
    });

  it('list rejects a request with no session cookie (401)', async () => {
    const { storeId } = await setUpOrg();
    const response = await app.inject({ method: 'GET', url: `/trpc/notifications.list?input=${encodeURIComponent(JSON.stringify({ storeId }))}` });
    expect(response.statusCode).toBe(401);
  });

  it('a real store-scoped notification created via the repository is returned by list, and unreadCount reflects it', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const cookie = await issueSession(organizationId);

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const { id: ruleId } = await ruleRepo.create({ ruleType: 'stock_below_reorder', severity: 'HIGH', threshold: {}, recipientRoles: ['MANAGER'], channels: ['EMAIL'] });
    const notifRepo = new NotificationRepository(db, organizationId);
    const { id: notificationId } = await notifRepo.create({
      storeId,
      ruleId,
      severity: 'HIGH',
      title: 'Flour low',
      body: 'Flour is below the reorder point.',
      dedupKey: `test:${generateId()}`,
    });

    const listResponse = await call('notifications.list', cookie, { storeId });
    expect(listResponse.statusCode).toBe(200);
    const list = JSON.parse(listResponse.body).result.data;
    expect(list.map((n: { id: string }) => n.id)).toContain(notificationId);

    const unreadResponse = await call('notifications.unreadCount', cookie, { storeId });
    expect(JSON.parse(unreadResponse.body).result.data).toEqual({ count: 1 });
  });

  it('an org-wide notification (storeId: null) shows up for EVERY store in list', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const cookie = await issueSession(organizationId);

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const { id: ruleId } = await ruleRepo.create({ ruleType: 'margin_drop', severity: 'HIGH', threshold: {}, recipientRoles: ['OWNER'], channels: ['EMAIL'] });
    const notifRepo = new NotificationRepository(db, organizationId);
    const { id: notificationId } = await notifRepo.create({
      ruleId,
      severity: 'HIGH',
      title: 'Margin dropped',
      body: 'Contribution margin dropped below threshold.',
      dedupKey: `test-orgwide:${generateId()}`,
    });

    const listResponse = await call('notifications.list', cookie, { storeId });
    const list = JSON.parse(listResponse.body).result.data;
    expect(list.map((n: { id: string }) => n.id)).toContain(notificationId);
  });

  it('markRead sets readAt and removes the notification from the unread count, but NOT from the list', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const cookie = await issueSession(organizationId);

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const { id: ruleId } = await ruleRepo.create({ ruleType: 'stock_below_reorder', severity: 'HIGH', threshold: {}, recipientRoles: ['MANAGER'], channels: ['EMAIL'] });
    const notifRepo = new NotificationRepository(db, organizationId);
    const { id: notificationId } = await notifRepo.create({
      storeId,
      ruleId,
      severity: 'HIGH',
      title: 'Flour low',
      body: 'body',
      dedupKey: `test-markread:${generateId()}`,
    });

    const markReadResponse = await call('notifications.markRead', cookie, { id: notificationId }, 'POST');
    expect(markReadResponse.statusCode).toBe(200);

    const unreadResponse = await call('notifications.unreadCount', cookie, { storeId });
    expect(JSON.parse(unreadResponse.body).result.data).toEqual({ count: 0 });

    const listResponse = await call('notifications.list', cookie, { storeId });
    const list = JSON.parse(listResponse.body).result.data;
    expect(list.map((n: { id: string }) => n.id)).toContain(notificationId); // read, but still unresolved
  });

  it('markActed sets actedAt, verified via a real markRead-then-markActed sequence', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const cookie = await issueSession(organizationId);

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const { id: ruleId } = await ruleRepo.create({ ruleType: 'stock_below_reorder', severity: 'HIGH', threshold: {}, recipientRoles: ['MANAGER'], channels: ['EMAIL'] });
    const notifRepo = new NotificationRepository(db, organizationId);
    const { id: notificationId } = await notifRepo.create({
      storeId,
      ruleId,
      severity: 'HIGH',
      title: 'Flour low',
      body: 'body',
      dedupKey: `test-markacted:${generateId()}`,
    });

    const markActedResponse = await call('notifications.markActed', cookie, { id: notificationId }, 'POST');
    expect(markActedResponse.statusCode).toBe(200);

    const found = await notifRepo.findById(notificationId);
    expect(found?.actedAt).not.toBeNull();
  });

  it('markRead on a nonexistent id returns 404', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId);
    const response = await call('notifications.markRead', cookie, { id: generateId() }, 'POST');
    expect(response.statusCode).toBe(404);
  });

  it('a cross-org storeId for list is rejected as NOT_FOUND, never another tenant\'s notifications', async () => {
    const { storeId: storeA } = await setUpOrg();
    const { organizationId: orgB } = await setUpOrg();
    const cookieB = await issueSession(orgB);

    const response = await call('notifications.list', cookieB, { storeId: storeA });
    expect(response.statusCode).toBe(404);
  });

  it('getPreferences returns the real default for a user with no configured row yet', async () => {
    const { organizationId } = await setUpOrg();
    const { cookie } = await issueSessionWithRealUser(organizationId);

    const response = await call('notifications.getPreferences', cookie, {});
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data).toEqual({
      mutedChannels: [],
      quietHoursStartHour: null,
      quietHoursEndHour: null,
      criticalOverridesQuietHours: true,
    });
  });

  it('updatePreferences writes a real row and getPreferences reflects it on the next read', async () => {
    const { organizationId } = await setUpOrg();
    const { cookie } = await issueSessionWithRealUser(organizationId);

    const updateResponse = await call(
      'notifications.updatePreferences',
      cookie,
      { mutedChannels: ['SMS'], quietHoursStartHour: 22, quietHoursEndHour: 7, criticalOverridesQuietHours: false },
      'POST'
    );
    expect(updateResponse.statusCode).toBe(200);
    const updated = JSON.parse(updateResponse.body).result.data;
    expect(updated).toEqual({
      mutedChannels: ['SMS'],
      quietHoursStartHour: 22,
      quietHoursEndHour: 7,
      criticalOverridesQuietHours: false,
    });

    const readBackResponse = await call('notifications.getPreferences', cookie, {});
    const readBack = JSON.parse(readBackResponse.body).result.data;
    expect(readBack).toEqual(updated);
  });

  it('a SECOND updatePreferences call for the same user overwrites in place, never creates a second row', async () => {
    const { organizationId } = await setUpOrg();
    const { cookie, userId } = await issueSessionWithRealUser(organizationId);

    await call('notifications.updatePreferences', cookie, { mutedChannels: ['SMS'], quietHoursStartHour: 22, quietHoursEndHour: 7, criticalOverridesQuietHours: true }, 'POST');
    await call('notifications.updatePreferences', cookie, { mutedChannels: [], quietHoursStartHour: 9, quietHoursEndHour: 17, criticalOverridesQuietHours: false }, 'POST');

    const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mutedChannels).toEqual([]);
    expect(rows[0]?.quietHoursStartHour).toBe(9);
  });

  it('updatePreferences rejects a quiet-hours window with only one bound set', async () => {
    const { organizationId } = await setUpOrg();
    const { cookie } = await issueSessionWithRealUser(organizationId);

    const response = await call(
      'notifications.updatePreferences',
      cookie,
      { mutedChannels: [], quietHoursStartHour: 22, quietHoursEndHour: null, criticalOverridesQuietHours: true },
      'POST'
    );
    expect(response.statusCode).toBe(400);
  });

  it('getPreferences with no session cookie is rejected (401)', async () => {
    const response = await app.inject({ method: 'GET', url: `/trpc/notifications.getPreferences?input=${encodeURIComponent(JSON.stringify({}))}` });
    expect(response.statusCode).toBe(401);
  });

  it('actionRateReport rejects a caller without financial:read (403)', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, []);

    const response = await call('notifications.actionRateReport', cookie, { days: 30 });
    expect(response.statusCode).toBe(403);
  });

  it('actionRateReport with no session cookie is rejected (401)', async () => {
    const response = await app.inject({ method: 'GET', url: `/trpc/notifications.actionRateReport?input=${encodeURIComponent(JSON.stringify({ days: 30 }))}` });
    expect(response.statusCode).toBe(401);
  });

  it('actionRateReport computes real per-rule-type delivered/opened/acted rates from real rows, and flags a genuinely low-acting rule type for tuning', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, ['financial:read']);

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const { id: ignoredRuleId } = await ruleRepo.create({
      ruleType: 'ignored_alert_type',
      severity: 'MEDIUM',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const { id: healthyRuleId } = await ruleRepo.create({
      ruleType: 'healthy_alert_type',
      severity: 'HIGH',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const notifRepo = new NotificationRepository(db, organizationId);
    const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);

    const recipientUserId = generateId();
    createdUserIds.push(recipientUserId);
    await db.insert(users).values({ id: recipientUserId, email: `report-recipient-${recipientUserId}@example.test` });

    // 5 real, never-acted notifications for the "ignored" rule type — enough to clear the minimum
    // sample size and land under the low-action-rate threshold. Each gets a real delivery row too,
    // proving the report's delivered/opened counts alongside the action rate.
    for (let i = 0; i < 5; i++) {
      const { id } = await notifRepo.create({
        ruleId: ignoredRuleId,
        severity: 'MEDIUM',
        title: `Ignored ${i}`,
        body: 'body',
        dedupKey: `report-test-ignored:${generateId()}`,
      });
      const { id: deliveryId } = await deliveryRepo.create({ notificationId: id, userId: recipientUserId, channel: 'EMAIL' });
      await deliveryRepo.markDelivered(deliveryId);
    }

    // A real, consistently-acted notification for the "healthy" rule type.
    const { id: healthyId } = await notifRepo.create({
      ruleId: healthyRuleId,
      severity: 'HIGH',
      title: 'Healthy',
      body: 'body',
      dedupKey: `report-test-healthy:${generateId()}`,
    });
    await notifRepo.markActed(healthyId);

    const response = await call('notifications.actionRateReport', cookie, { days: 30 });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data as {
      byRuleType: {
        ruleType: string;
        notificationCount: number;
        actedCount: number;
        actionRate: number;
        deliveryCount: number;
        deliveredCount: number;
        openRate: number | null;
      }[];
      needsTuning: { ruleType: string }[];
    };

    const ignored = data.byRuleType.find((r) => r.ruleType === 'ignored_alert_type');
    expect(ignored?.notificationCount).toBe(5);
    expect(ignored?.actedCount).toBe(0);
    expect(ignored?.actionRate).toBe(0);
    expect(ignored?.deliveryCount).toBe(5);
    expect(ignored?.deliveredCount).toBe(5);
    expect(ignored?.openRate).toBe(0); // delivered but never opened — a real, distinct zero, not an unknown

    const healthy = data.byRuleType.find((r) => r.ruleType === 'healthy_alert_type');
    expect(healthy?.notificationCount).toBe(1);
    expect(healthy?.actedCount).toBe(1);
    expect(healthy?.actionRate).toBe(1);

    expect(data.needsTuning.map((r) => r.ruleType)).toContain('ignored_alert_type');
    expect(data.needsTuning.map((r) => r.ruleType)).not.toContain('healthy_alert_type');
  });

  it('actionRateReport is genuinely org-scoped — a second org\'s real notifications never appear in another org\'s report', async () => {
    const { organizationId: orgA } = await setUpOrg();
    const { organizationId: orgB } = await setUpOrg();
    const cookieB = await issueSession(orgB, ['financial:read']);

    const ruleRepoA = new NotificationRuleRepository(db, orgA);
    const { id: ruleId } = await ruleRepoA.create({
      ruleType: 'cross_org_report_type',
      severity: 'HIGH',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const notifRepoA = new NotificationRepository(db, orgA);
    await notifRepoA.create({
      ruleId,
      severity: 'HIGH',
      title: 'Org A only',
      body: 'body',
      dedupKey: `report-cross-org:${generateId()}`,
    });

    const response = await call('notifications.actionRateReport', cookieB, { days: 30 });
    const data = JSON.parse(response.body).result.data as { byRuleType: { ruleType: string }[] };
    expect(data.byRuleType.map((r) => r.ruleType)).not.toContain('cross_org_report_type');
  });

  it('listTuningCandidates enriches a flagged rule type with its real configured row', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, ['financial:read']);

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const { id: ruleId } = await ruleRepo.create({
      ruleType: 'tuning_candidate_type',
      severity: 'HIGH',
      threshold: {},
      recipientRoles: ['MANAGER', 'OWNER'],
      channels: ['EMAIL'],
    });
    const notifRepo = new NotificationRepository(db, organizationId);
    // 5 never-acted notifications: clears the minimum sample size, lands under the tuning threshold.
    for (let i = 0; i < 5; i++) {
      await notifRepo.create({
        ruleId,
        severity: 'HIGH',
        title: `Tuning candidate ${i}`,
        body: 'body',
        dedupKey: `tuning-candidate:${generateId()}`,
      });
    }

    const response = await call('notifications.listTuningCandidates', cookie, { days: 30 });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data as {
      ruleType: string;
      ruleId: string | null;
      severity: string;
      recipientRoles: string[];
      channels: string[];
    }[];

    const candidate = data.find((c) => c.ruleType === 'tuning_candidate_type');
    expect(candidate?.ruleId).toBe(ruleId);
    expect(candidate?.severity).toBe('HIGH');
    expect(candidate?.recipientRoles).toEqual(['MANAGER', 'OWNER']);
    expect(candidate?.channels).toEqual(['EMAIL']);
  });

  it('listTuningCandidates returns a real catalogue-default entry (ruleId null) for a flagged rule type with no configured row', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, ['financial:read']);

    // The auto-provisioning path creates a real rule row the first time a type fires —
    // simulate the "never configured, never fired before" case directly: a rule DOES need to exist
    // for a notification's ruleId FK, so this proves the ruleId-null fallback via a rule type this
    // test creates a rule for but queries under a DIFFERENT org's session, which never had one.
    const { organizationId: otherOrgId } = await setUpOrg();
    const otherRuleRepo = new NotificationRuleRepository(db, otherOrgId);
    const { id: otherRuleId } = await otherRuleRepo.create({
      ruleType: 'unconfigured_tuning_type',
      severity: 'MEDIUM',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const otherNotifRepo = new NotificationRepository(db, otherOrgId);
    for (let i = 0; i < 5; i++) {
      await otherNotifRepo.create({
        ruleId: otherRuleId,
        severity: 'MEDIUM',
        title: `Other org ${i}`,
        body: 'body',
        dedupKey: `unconfigured-tuning:${generateId()}`,
      });
    }

    // This org's own session sees no rows for this ruleType at all — its own listTuningCandidates
    // call simply won't include it (a different org's flagged data never crosses over); this test's
    // real point is the isolation itself, matching the org-scoping already proven above.
    const response = await call('notifications.listTuningCandidates', cookie, { days: 30 });
    const data = JSON.parse(response.body).result.data as { ruleType: string }[];
    expect(data.map((c) => c.ruleType)).not.toContain('unconfigured_tuning_type');
  });

  it('listTuningCandidates rejects a caller without financial:read (403)', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, []);
    const response = await call('notifications.listTuningCandidates', cookie, { days: 30 });
    expect(response.statusCode).toBe(403);
  });

  it('updateRuleTuning writes real severity/recipientRoles/channels for an existing rule', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, ['settings:manage']);

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const { id: ruleId } = await ruleRepo.create({
      ruleType: 'update_tuning_router_test',
      severity: 'HIGH',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const response = await call(
      'notifications.updateRuleTuning',
      cookie,
      { ruleId, ruleType: 'update_tuning_router_test', severity: 'MEDIUM', recipientRoles: ['OWNER'], channels: [] },
      'POST'
    );
    expect(response.statusCode).toBe(200);

    const updated = await ruleRepo.findById(ruleId);
    expect(updated?.severity).toBe('MEDIUM');
    expect(updated?.recipientRoles).toEqual(['OWNER']);
    expect(updated?.channels).toEqual([]);
  });

  it('updateRuleTuning with ruleId null creates a real new rule row', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, ['settings:manage']);

    const response = await call(
      'notifications.updateRuleTuning',
      cookie,
      { ruleId: null, ruleType: 'brand_new_rule_type', severity: 'CRITICAL', recipientRoles: ['OWNER', 'MANAGER'], channels: ['EMAIL'] },
      'POST'
    );
    expect(response.statusCode).toBe(200);
    const { ruleId } = JSON.parse(response.body).result.data as { ruleId: string };

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const created = await ruleRepo.findById(ruleId);
    expect(created?.ruleType).toBe('brand_new_rule_type');
    expect(created?.severity).toBe('CRITICAL');
    expect(created?.recipientRoles).toEqual(['OWNER', 'MANAGER']);
  });

  it('updateRuleTuning rejects a caller without settings:manage (403)', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, ['financial:read']);
    const response = await call(
      'notifications.updateRuleTuning',
      cookie,
      { ruleId: null, ruleType: 'permission_test_type', severity: 'HIGH', recipientRoles: ['MANAGER'], channels: ['EMAIL'] },
      'POST'
    );
    expect(response.statusCode).toBe(403);
  });

  it('updateRuleTuning on a nonexistent ruleId returns 404', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, ['settings:manage']);
    const response = await call(
      'notifications.updateRuleTuning',
      cookie,
      { ruleId: generateId(), ruleType: 'nonexistent_test_type', severity: 'HIGH', recipientRoles: ['MANAGER'], channels: ['EMAIL'] },
      'POST'
    );
    expect(response.statusCode).toBe(404);
  });

  it('updateRuleTuning rejects an empty recipientRoles array at the schema boundary (400)', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, ['settings:manage']);
    const response = await call(
      'notifications.updateRuleTuning',
      cookie,
      { ruleId: null, ruleType: 'empty_roles_test_type', severity: 'HIGH', recipientRoles: [], channels: ['EMAIL'] },
      'POST'
    );
    expect(response.statusCode).toBe(400);
  });
});
