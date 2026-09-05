import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { investigations, notificationRules, notifications, organizations, stores } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { InvestigationRepository } from './investigation-repository';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('InvestigationRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let ruleId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Investigation Repo Test Org',
      slug: `investigation-repo-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    ruleId = generateId();
    await adminDb.insert(notificationRules).values({
      id: ruleId,
      organizationId,
      ruleType: 'sales_anomaly',
      threshold: {},
      severity: 'MEDIUM',
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
    await client.end();
    await adminClient.end();
  });

  const seedNotification = async (): Promise<string> => {
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

  it('createRunning then complete produces a real, terminal COMPLETE row with the real trace/draft persisted', async () => {
    const repo = new InvestigationRepository(createScopedDb(client), organizationId);
    const { id } = await repo.createRunning({ storeId, question: 'Why did margin drop?' });

    const running = await repo.findById(id);
    expect(running?.status).toBe('RUNNING');

    await repo.complete(id, { hopCount: 2, trace: [{ hop: 1 }, { hop: 2 }], draft: { lines: [] } });

    const completed = await repo.findById(id);
    expect(completed?.status).toBe('COMPLETE');
    expect(completed?.hopCount).toBe(2);
    expect(completed?.trace).toEqual([{ hop: 1 }, { hop: 2 }]);
    expect(completed?.draft).toEqual({ lines: [] });
  });

  it('fail produces a real terminal FAILED row with the real error, never silently discarded', async () => {
    const repo = new InvestigationRepository(createScopedDb(client), organizationId);
    const { id } = await repo.createRunning({ question: 'test' });
    await repo.fail(id, 'provider timeout');

    const failed = await repo.findById(id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toBe('provider timeout');
  });

  it('findBySourceNotificationId finds a real proactively-triggered investigation — the sweep\'s own idempotency check', async () => {
    const notificationId = await seedNotification();
    const repo = new InvestigationRepository(createScopedDb(client), organizationId);
    await repo.createRunning({ storeId, sourceNotificationId: notificationId, question: 'auto-investigate' });

    const found = await repo.findBySourceNotificationId(notificationId);
    expect(found).not.toBeNull();
    expect(found?.sourceNotificationId).toBe(notificationId);
  });

  it('findBySourceNotificationId returns null for a notification with no investigation yet', async () => {
    const notificationId = await seedNotification();
    const repo = new InvestigationRepository(createScopedDb(client), organizationId);
    const found = await repo.findBySourceNotificationId(notificationId);
    expect(found).toBeNull();
  });

  it('the unique index prevents two investigations for the same source notification', async () => {
    const notificationId = await seedNotification();
    const repo = new InvestigationRepository(createScopedDb(client), organizationId);
    await repo.createRunning({ sourceNotificationId: notificationId, question: 'first' });

    await expect(repo.createRunning({ sourceNotificationId: notificationId, question: 'second' })).rejects.toThrow();
  });

  it('findRecentProactive only returns COMPLETE investigations with a real sourceNotificationId, never an on-demand or still-running one', async () => {
    const notificationId = await seedNotification();
    const repo = new InvestigationRepository(createScopedDb(client), organizationId);

    const { id: proactiveId } = await repo.createRunning({ sourceNotificationId: notificationId, question: 'proactive' });
    await repo.complete(proactiveId, { hopCount: 1, trace: [], draft: null });

    const { id: onDemandId } = await repo.createRunning({ question: 'on-demand, no source notification' });
    await repo.complete(onDemandId, { hopCount: 1, trace: [], draft: null });

    const stillRunningNotificationId = await seedNotification();
    await repo.createRunning({ sourceNotificationId: stillRunningNotificationId, question: 'still running' });

    const recent = await repo.findRecentProactive();
    expect(recent.map((r) => r.id)).toEqual([proactiveId]);
  });
});
