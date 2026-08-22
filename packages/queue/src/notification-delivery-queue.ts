import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const NOTIFICATION_DELIVERY_QUEUE_NAME = 'notification-delivery';

/**
 * One job per `notification_deliveries` row — created when a rule evaluation genuinely CREATEs a
 * new notification (never on an UPDATE/RESOLVE, matching the plan's own "notification fatigue is
 * the failure mode" framing: an already-delivered alert updating in place must not re-send).
 */
export interface NotificationDeliveryJobData {
  deliveryId: string;
  organizationId: string;
}

/**
 * "Email delivery with retry + DLQ." `attempts`/`backoff` are BullMQ's own real retry
 * mechanism — matching `extraction-queue.ts`'s exact precedent (a transient send failure, e.g. a
 * provider timeout, gets a few real retries before the processor itself marks the delivery
 * `DEAD_LETTERED`; see `notification-delivery-processor.ts`). `jobId: deliveryId` gives the same
 * free idempotency every other queue in this codebase already relies on — a duplicate enqueue for
 * a delivery already queued never creates a second job.
 */
export const createNotificationDeliveryQueue = (connection: Redis): Queue<NotificationDeliveryJobData> =>
  new Queue<NotificationDeliveryJobData>(NOTIFICATION_DELIVERY_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 200,
      removeOnFail: 1000,
    },
  });

export const enqueueNotificationDeliveryJob = async (
  queue: Queue<NotificationDeliveryJobData>,
  data: NotificationDeliveryJobData
): Promise<void> => {
  await queue.add('deliver', data, { jobId: data.deliveryId });
};
