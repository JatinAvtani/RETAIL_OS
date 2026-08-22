import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { NotificationDeliveryRepository, NotificationRepository, createDb, users } from '@retailos/db';
import { buildNotificationEmailContent } from '@retailos/domain';
import type { NotificationEmailSender } from '@retailos/email';
import type { NotificationDeliveryJobData } from '@retailos/queue';

/**
 * "Email delivery with retry + DLQ" — the real first caller of
 * `NotificationDeliveryRepository.findPending`/`markDelivered`, which existed with no consumer
 * beforehand, matching the "schema built ahead of its consumer" pattern used throughout.
 *
 * Retry is BullMQ's own mechanism (`createNotificationDeliveryQueue`'s `attempts`/`backoff`,
 * matching `extraction-queue.ts`'s exact precedent) — this processor THROWS on a transient send
 * failure so BullMQ re-attempts with exponential backoff, rather than looping/sleeping itself. The
 * DLQ is `notification_deliveries.status = 'DEAD_LETTERED'` (the enum value existed before this
 * processor did) — not a separate dead-letter queue/table, which would duplicate what that column already
 * models. A delivery is only marked DEAD_LETTERED once `job.attemptsMade` has reached the queue's
 * configured `attempts` budget — i.e. this really was the LAST attempt, not merely A failed one;
 * every earlier attempt marks `FAILED` (still retryable) and rethrows so BullMQ's own retry
 * scheduling proceeds normally.
 */
export const createNotificationDeliveryProcessor = (config: { databaseUrl: string; emailSender: NotificationEmailSender }) => {
  const { db } = createDb(config.databaseUrl);

  return async (job: Job<NotificationDeliveryJobData>): Promise<void> => {
    const { deliveryId, organizationId } = job.data;
    const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
    const notificationRepo = new NotificationRepository(db, organizationId);

    const delivery = await deliveryRepo.findById(deliveryId);
    if (!delivery) {
      // The delivery row itself is gone (e.g. cleaned up by a since-superseded test/admin action)
      // — nothing to deliver, and retrying can never fix a missing row. A genuine terminal no-op,
      // not a transient failure to retry.
      return;
    }
    if (delivery.channel !== 'EMAIL') {
      // Only EMAIL is a real transport this task builds — any other configured channel (e.g. a
      // future SMS/push row) has no sender wired yet. Left PENDING rather than marked FAILED: an
      // unimplemented channel is a configuration gap, not a genuine delivery failure (I7 — don't
      // report a failure that didn't actually happen).
      return;
    }

    const notification = await notificationRepo.findById(delivery.notificationId);
    if (!notification) {
      // The parent notification is gone — same reasoning as the missing-delivery case above.
      return;
    }

    const userRows = await db.select({ email: users.email }).from(users).where(eq(users.id, delivery.userId));
    const userRow = userRows[0];
    if (!userRow) {
      // No real address to send to — a genuine, non-retryable configuration gap (the user row is
      // gone), not a transient transport failure.
      await deliveryRepo.markDeadLettered(deliveryId, 'No user record found for this delivery.');
      return;
    }

    const content = buildNotificationEmailContent({
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
      dollarImpact: notification.dollarImpact,
    });

    const result = await config.emailSender.send({ to: userRow.email, subject: content.subject, bodyText: content.bodyText });

    if (result.ok) {
      await deliveryRepo.markDelivered(deliveryId);
      return;
    }

    const attemptsBudget = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attemptsBudget;
    if (isFinalAttempt) {
      await deliveryRepo.markDeadLettered(deliveryId, result.error);
      // Deliberately does NOT rethrow — this attempt genuinely is the last one BullMQ will make
      // (retrying further would just repeat the same terminal failure), so the job should complete
      // rather than land in BullMQ's own failed set with nothing left to retry.
      return;
    }

    await deliveryRepo.markFailed(deliveryId, result.error);
    throw new Error(result.error);
  };
};
