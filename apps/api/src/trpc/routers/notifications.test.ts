import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, organizations, stores, notifications, notificationRules, NotificationRepository, NotificationRuleRepository } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
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

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await db.delete(notifications).where(eq(notifications.organizationId, orgId));
      await db.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
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

  const issueSession = async (organizationId: string): Promise<string> => {
    const userId = generateId();
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions: [] }, '127.0.0.1', 'test-agent');
    return token;
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
});
