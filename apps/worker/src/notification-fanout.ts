import {
  MembershipListRepository,
  NotificationDeliveryRepository,
  NotificationPreferenceRepository,
  StoreRepository,
  createDb,
} from '@retailos/db';
import { shouldSuppressDelivery, type AlertSeverity } from '@retailos/domain';
import { createQueueRedisConnection, createNotificationDeliveryQueue, enqueueNotificationDeliveryJob } from '@retailos/queue';

/**
 * Shared fan-out for a genuinely NEW notification — used by every real rule-evaluation site in
 * this worker (`stock_below_reorder`, `daily_briefing`) so there is exactly ONE
 * implementation of "resolve recipients → check per-user preferences → create delivery rows →
 * enqueue" (I2: not two independently-written, independently-drifting fan-out paths). Extracted
 * from `rule-evaluation-processor.ts` when the daily briefing needed the identical logic — never called on an
 * UPDATE/RESOLVE, matching the plan's own "notification fatigue is the failure mode" framing (an
 * alert updating in place while still open must not re-send).
 *
 * Resolves real recipients via `recipientRoles`/`storeId`, consults each recipient's own
 * `notification_preferences` (muted channels, quiet hours + critical override) via
 * `shouldSuppressDelivery` BEFORE creating a delivery row — a suppressed (recipient, channel) pair
 * gets NO row at all, not a row that silently never sends. EMAIL is the only real transport this
 * epic builds; any other configured channel gets a real `PENDING` delivery row with no sender wired
 * yet, matching `notification-delivery-processor.ts`'s own "unimplemented channel is a config gap,
 * not a failure" reasoning.
 */
export const notifyRecipients = async (
  db: ReturnType<typeof createDb>['db'],
  redisUrl: string,
  organizationId: string,
  notificationId: string,
  storeId: string | null,
  severity: AlertSeverity,
  recipientRoles: string[],
  channels: string[]
): Promise<void> => {
  const membershipRepo = new MembershipListRepository(db, organizationId);
  const recipients = await membershipRepo.findAcceptedByRoles(storeId, recipientRoles);
  if (recipients.length === 0) return;

  const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
  const preferenceRepo = new NotificationPreferenceRepository(db, organizationId);
  const storeRepo = new StoreRepository(db, organizationId);
  const deliveryQueue = createNotificationDeliveryQueue(createQueueRedisConnection(redisUrl));
  const orgStoreCache: { value: { id: string; timezone: string }[] | null } = { value: null };
  const now = new Date();

  /**
   * Resolves the real IANA timezone a recipient's quiet-hours check evaluates against. A
   * store-scoped notification (`storeId` non-null) uses that store's own timezone directly — one
   * lookup, shared by every recipient. An ORG-WIDE notification has no single store to anchor to;
   * confirmed with the user: use the recipient's own first/primary accessible store (their
   * membership's `storeIds`, or — for an unrestricted `storeIds: null` member — the org's first
   * store) as a pragmatic single-timezone-per-user assumption. Falls back to UTC only when the
   * recipient genuinely has no resolvable store at all.
   */
  const resolveRecipientTimezone = async (recipientStoreIds: string[] | null): Promise<string> => {
    if (storeId !== null) {
      const store = await storeRepo.findById(storeId);
      return store?.timezone ?? 'UTC';
    }
    if (recipientStoreIds && recipientStoreIds.length > 0) {
      const store = await storeRepo.findById(recipientStoreIds[0]!);
      if (store) return store.timezone;
    }
    if (orgStoreCache.value === null) {
      orgStoreCache.value = await storeRepo.findAll();
    }
    return orgStoreCache.value[0]?.timezone ?? 'UTC';
  };

  for (const recipient of recipients) {
    const preference = await preferenceRepo.findOrDefaultForUser(recipient.userId);
    const timezone = await resolveRecipientTimezone(recipient.storeIds);

    for (const channel of channels) {
      if (shouldSuppressDelivery(preference, channel, severity, now, timezone)) continue;

      const { id: deliveryId } = await deliveryRepo.create({ notificationId, userId: recipient.userId, channel });
      if (channel === 'EMAIL') {
        await enqueueNotificationDeliveryJob(deliveryQueue, { deliveryId, organizationId });
      }
    }
  }
};
