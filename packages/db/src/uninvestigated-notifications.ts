import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';
import { investigations, notificationRules, notifications } from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type UninvestigatedNotification = {
 id: string;
 organizationId: string;
 storeId: string | null;
 title: string;
 body: string;
};

/**
 * the auto-trigger sweep's own real query — matching
 * `findOpenNotificationsByDedupPrefix`'s established shape (cross-tenant, admin-equivalent
 * connection, since a worker tick has no single tenant to scope to). Finds every open notification
 * of an investigable rule type that has NO `investigations` row yet — a real anti-join
 * (`LEFT JOIN investigations... WHERE investigations.id IS NULL`) against
 * `investigations.sourceNotificationId`, not a dedup-key-prefix string match, since that column
 * exists specifically to answer this question directly and unambiguously (the unique index on
 * `(organization_id, source_notification_id)` is this query's own real idempotency guarantee, not
 * just this function's SELECT).
 *
 * `ruleTypes` is caller-supplied rather than hardcoded to `sales_anomaly` alone — a future
 * proactive `supplier_price_increase` evaluator (its own sibling) will need the identical trigger
 * shape once it exists, and this function is already generic over "which rule types can start an
 * investigation," matching this codebase's "detection lives in one place" discipline (I2) rather
 * than a second copy of this query per rule type. An empty `ruleTypes` array returns nothing — an
 * explicit, honest empty result, never every notification by accident.
 */
export const findUninvestigatedNotifications = async (
  db: Db,
  ruleTypes: readonly string[],
  limit = 100
): Promise<UninvestigatedNotification[]> => {
  if (ruleTypes.length === 0) return [];

  return db
    .select({
      id: notifications.id,
      organizationId: notifications.organizationId,
      storeId: notifications.storeId,
      title: notifications.title,
      body: notifications.body,
    })
    .from(notifications)
    .innerJoin(notificationRules, eq(notificationRules.id, notifications.ruleId))
    .leftJoin(investigations, eq(investigations.sourceNotificationId, notifications.id))
    .where(
      and(
        isNull(notifications.resolvedAt),
        isNull(investigations.id),
        inArray(notificationRules.ruleType, ruleTypes as string[])
      )
    )
    /**
     * Newest first, and explicitly ordered at all.
     *
     * Without an ORDER BY, `limit` returns an ARBITRARY subset — harmless while the caller
     * processed every row it got back, and a real defect once the trigger started capping each
     * tick to protect the model provider's per-minute quota: an unordered cap can return the same
     * stale rows every tick and starve a genuinely new finding forever.
     *
     * Newest-first is the honest priority for this consumer. A finding someone might act on today
     * is worth more than one that has sat unqueried, and a backlog that cannot be cleared in one
     * tick should still surface what just happened rather than what happened first.
     */
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
};
