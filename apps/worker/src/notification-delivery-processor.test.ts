import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { generateId } from '@retailos/domain';
import { createMockNotificationEmailSender, type NotificationEmailSender, type SendNotificationEmailInput } from '@retailos/email';
import {
  createDb,
  organizations,
  users,
  memberships,
  notifications,
  notificationRules,
  notificationDeliveries,
  NotificationRuleRepository,
  NotificationRepository,
  NotificationDeliveryRepository,
} from '@retailos/db';
import { createNotificationDeliveryProcessor } from './notification-delivery-processor';
import type { NotificationDeliveryJobData } from '@retailos/queue';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const asJob = (data: NotificationDeliveryJobData, opts: { attemptsMade: number; attempts: number }): Job<NotificationDeliveryJobData> =>
  ({ data, attemptsMade: opts.attemptsMade, opts: { attempts: opts.attempts } }) as Job<NotificationDeliveryJobData>;

/**
 * Proves the delivery pipeline's real behavior against real Postgres: a successful send marks DELIVERED with
 * the right recipient/subject/body; a transient failure that is NOT the final attempt marks
 * FAILED and rethrows (so BullMQ's own retry proceeds); a transient failure on the genuinely
 * LAST attempt marks DEAD_LETTERED and does NOT rethrow (nothing left to retry).
 */
describe('notification delivery processor', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, orgId));
      await adminDb.delete(notifications).where(eq(notifications.organizationId, orgId));
      await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      const orgMemberships = await adminDb.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.organizationId, orgId));
      await adminDb.delete(memberships).where(eq(memberships.organizationId, orgId));
      for (const m of orgMemberships) {
        await adminDb.delete(users).where(eq(users.id, m.userId));
      }
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  const setUpOrgUserNotificationDelivery = async (input: { dollarImpact?: string } = {}) => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Delivery Test Org', slug: `delivery-test-${organizationId}`, baseCurrency: 'USD' });

    const userId = generateId();
    const userEmail = `recipient-${userId}@example.test`;
    // memberships is FORCE RLS — a plain insert through the app-role `db` connection with no
    // tenant context set throws "unrecognized configuration parameter", the exact class this
    // project's own memory already names (a plain query outside a repository needs its own
    // tenant context). Insert via the admin (superuser) connection instead, matching every other
    // fixture-setup precedent in this codebase (e.g. tenant-fixture.ts).
    await adminDb.insert(users).values({ id: userId, email: userEmail });
    await adminDb.insert(memberships).values({ id: generateId(), organizationId, userId, role: 'MANAGER', storeIds: null, acceptedAt: new Date() });

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const { id: ruleId } = await ruleRepo.create({
      ruleType: 'stock_below_reorder',
      severity: 'HIGH',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const notificationRepo = new NotificationRepository(db, organizationId);
    const { id: notificationId } = await notificationRepo.create({
      ruleId,
      severity: 'HIGH',
      title: 'Stock below reorder point',
      body: 'Product X is at or below its configured reorder point.',
      dedupKey: `stock_below_reorder:${generateId()}`,
      ...(input.dollarImpact !== undefined ? { dollarImpact: input.dollarImpact } : {}),
    });

    const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
    const { id: deliveryId } = await deliveryRepo.create({ notificationId, userId, channel: 'EMAIL' });

    return { organizationId, userId, userEmail, notificationId, deliveryId, deliveryRepo };
  };

  it('a successful send marks the delivery DELIVERED and sends to the real recipient with the right content', async () => {
    const { organizationId, userEmail, deliveryId, deliveryRepo } = await setUpOrgUserNotificationDelivery({ dollarImpact: '340.0000' });

    const sentEmails: SendNotificationEmailInput[] = [];
    const emailSender: NotificationEmailSender = createMockNotificationEmailSender({ onSend: (input) => sentEmails.push(input) });
    const processor = createNotificationDeliveryProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, emailSender });

    await processor(asJob({ deliveryId, organizationId }, { attemptsMade: 0, attempts: 5 }));

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe(userEmail);
    expect(sentEmails[0]?.subject).toContain('Stock below reorder point');
    expect(sentEmails[0]?.subject).toContain('340.00');

    const delivery = await deliveryRepo.findById(deliveryId);
    expect(delivery?.status).toBe('DELIVERED');
    expect(delivery?.deliveredAt).not.toBeNull();
  });

  it('a transient failure that is NOT the final attempt marks FAILED and rethrows so BullMQ retries', async () => {
    const { organizationId, deliveryId, deliveryRepo } = await setUpOrgUserNotificationDelivery();

    const emailSender: NotificationEmailSender = createMockNotificationEmailSender({ failFor: () => true });
    const processor = createNotificationDeliveryProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, emailSender });

    await expect(processor(asJob({ deliveryId, organizationId }, { attemptsMade: 0, attempts: 5 }))).rejects.toThrow();

    const delivery = await deliveryRepo.findById(deliveryId);
    expect(delivery?.status).toBe('FAILED');
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.error).toBeTruthy();
  });

  it('a transient failure on the genuinely LAST attempt marks DEAD_LETTERED and does NOT rethrow', async () => {
    const { organizationId, deliveryId, deliveryRepo } = await setUpOrgUserNotificationDelivery();

    const emailSender: NotificationEmailSender = createMockNotificationEmailSender({ failFor: () => true });
    const processor = createNotificationDeliveryProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, emailSender });

    // attemptsMade: 4 with a budget of 5 means this call IS the 5th and final attempt.
    await expect(processor(asJob({ deliveryId, organizationId }, { attemptsMade: 4, attempts: 5 }))).resolves.toBeUndefined();

    const delivery = await deliveryRepo.findById(deliveryId);
    expect(delivery?.status).toBe('DEAD_LETTERED');
    expect(delivery?.error).toBeTruthy();
  });

  it('a delivery for a non-EMAIL channel is left PENDING — an unimplemented transport is a config gap, not a failure', async () => {
    const { organizationId, notificationId, userId } = await setUpOrgUserNotificationDelivery();
    const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
    const { id: smsDeliveryId } = await deliveryRepo.create({ notificationId, userId, channel: 'SMS' });

    const emailSender: NotificationEmailSender = createMockNotificationEmailSender();
    const processor = createNotificationDeliveryProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, emailSender });

    await expect(processor(asJob({ deliveryId: smsDeliveryId, organizationId }, { attemptsMade: 0, attempts: 5 }))).resolves.toBeUndefined();

    const delivery = await deliveryRepo.findById(smsDeliveryId);
    expect(delivery?.status).toBe('PENDING');
  });
});
