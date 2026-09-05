import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from './schema/index';
import { investigations, notificationRules, notifications, organizations, stores } from './schema/index';
import { createScopedDb } from './tenant-repository';
import { InvestigationRepository } from './repositories/investigation-repository';
import { findUninvestigatedNotifications } from './uninvestigated-notifications';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * proves the auto-trigger sweep's own real query against real Postgres — this
 * function is cross-tenant by design (a worker tick has no single org to scope to, matching
 * `findOpenNotificationsByDedupPrefix`'s established precedent), so it's tested with the ADMIN
 * connection, not `createScopedDb`.
 */
describe('findUninvestigatedNotifications', () => {
  let adminClient: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let salesAnomalyRuleId: string;
  let stockRuleId: string;

  beforeAll(async () => {
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    appClient = postgres(APP_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Uninvestigated Notifications Test Org',
      slug: `uninvestigated-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    salesAnomalyRuleId = generateId();
    await adminDb.insert(notificationRules).values({
      id: salesAnomalyRuleId,
      organizationId,
      ruleType: 'sales_anomaly',
      threshold: {},
      severity: 'MEDIUM',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    stockRuleId = generateId();
    await adminDb.insert(notificationRules).values({
      id: stockRuleId,
      organizationId,
      ruleType: 'stock_below_reorder',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(investigations).where(eq(investigations.organizationId, organizationId));
    await adminDb.delete(notifications).where(eq(notifications.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await adminClient.end();
    await appClient.end();
  });

  const seedNotification = async (ruleId: string): Promise<string> => {
    const adminDb = drizzle(adminClient, { schema });
    const id = generateId();
    await adminDb.insert(notifications).values({
      id,
      organizationId,
      storeId,
      ruleId,
      severity: 'MEDIUM',
      title: 'test',
      body: 'test',
      dedupKey: `test-${id}`,
    });
    return id;
  };

  it('finds a real open sales_anomaly notification with no investigation yet', async () => {
    const notificationId = await seedNotification(salesAnomalyRuleId);
    const adminDb = drizzle(adminClient, { schema });

    const results = await findUninvestigatedNotifications(adminDb, ['sales_anomaly']);
    expect(results.some((r) => r.id === notificationId)).toBe(true);
  });

  it('excludes a notification whose rule type is NOT in the requested list', async () => {
    const notificationId = await seedNotification(stockRuleId);
    const adminDb = drizzle(adminClient, { schema });

    const results = await findUninvestigatedNotifications(adminDb, ['sales_anomaly']);
    expect(results.some((r) => r.id === notificationId)).toBe(false);
  });

  it('excludes a notification that ALREADY has a real investigation row — the sweep\'s own idempotency guarantee', async () => {
    const notificationId = await seedNotification(salesAnomalyRuleId);
    const investigationRepo = new InvestigationRepository(createScopedDb(appClient), organizationId);
    await investigationRepo.createRunning({ storeId, sourceNotificationId: notificationId, question: 'already investigating' });

    const adminDb = drizzle(adminClient, { schema });
    const results = await findUninvestigatedNotifications(adminDb, ['sales_anomaly']);
    expect(results.some((r) => r.id === notificationId)).toBe(false);
  });

  it('excludes a RESOLVED notification, never re-investigating a cleared finding', async () => {
    const notificationId = await seedNotification(salesAnomalyRuleId);
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.update(notifications).set({ resolvedAt: new Date() }).where(eq(notifications.id, notificationId));

    const results = await findUninvestigatedNotifications(adminDb, ['sales_anomaly']);
    expect(results.some((r) => r.id === notificationId)).toBe(false);
  });

  it('an empty ruleTypes array returns nothing — an honest empty result, never every notification by accident', async () => {
    await seedNotification(salesAnomalyRuleId);
    const adminDb = drizzle(adminClient, { schema });
    const results = await findUninvestigatedNotifications(adminDb, []);
    expect(results).toEqual([]);
  });
});
