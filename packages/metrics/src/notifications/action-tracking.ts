/**
 * Per-alert-type delivered/opened/acted rates from real `notifications`/`notification_deliveries`
 * rows the fan-out and delivery pipeline already writes — no new write path, pure
 * aggregation over data that already exists (I2). "Delivered" and "opened" are per-delivery-row
 * facts (email, one row per recipient/channel); "acted" is a per-NOTIFICATION fact (one click marks
 * the whole alert acted, regardless of how many people received it) — so a rule type's action rate
 * is `distinct acted notifications / distinct notifications`, not `acted deliveries / deliveries`,
 * which would silently double- or under-count whenever a notification fans out to more than one
 * recipient.
 */
export interface ActionTrackingRow {
  notificationId: string;
  ruleType: string;
  actedAt: Date | null;
  deliveryId: string | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
}

export interface ActionRateByType {
  ruleType: string;
  notificationCount: number;
  actedCount: number;
  /** null when this rule type has never had a real delivery row — a genuine unknown, never a fabricated 0% (I7). */
  deliveryCount: number;
  deliveredCount: number;
  openedCount: number;
  actionRate: number;
  /** null when `deliveryCount` is 0 — nothing has ever been delivered for this rule type yet. */
  openRate: number | null;
}

export const computeActionRatesByRuleType = (rows: ActionTrackingRow[]): ActionRateByType[] => {
  const byType = new Map<
    string,
    {
      notificationIds: Set<string>;
      actedNotificationIds: Set<string>;
      deliveryIds: Set<string>;
      deliveredDeliveryIds: Set<string>;
      openedDeliveryIds: Set<string>;
    }
  >();

  for (const row of rows) {
    let bucket = byType.get(row.ruleType);
    if (!bucket) {
      bucket = {
        notificationIds: new Set(),
        actedNotificationIds: new Set(),
        deliveryIds: new Set(),
        deliveredDeliveryIds: new Set(),
        openedDeliveryIds: new Set(),
      };
      byType.set(row.ruleType, bucket);
    }

    bucket.notificationIds.add(row.notificationId);
    if (row.actedAt !== null) bucket.actedNotificationIds.add(row.notificationId);
    if (row.deliveryId !== null) {
      bucket.deliveryIds.add(row.deliveryId);
      if (row.deliveredAt !== null) bucket.deliveredDeliveryIds.add(row.deliveryId);
      if (row.openedAt !== null) bucket.openedDeliveryIds.add(row.deliveryId);
    }
  }

  return [...byType.entries()]
    .map(([ruleType, bucket]) => {
      const notificationCount = bucket.notificationIds.size;
      const deliveryCount = bucket.deliveryIds.size;
      return {
        ruleType,
        notificationCount,
        actedCount: bucket.actedNotificationIds.size,
        deliveryCount,
        deliveredCount: bucket.deliveredDeliveryIds.size,
        openedCount: bucket.openedDeliveryIds.size,
        actionRate: notificationCount === 0 ? 0 : bucket.actedNotificationIds.size / notificationCount,
        openRate: deliveryCount === 0 ? null : bucket.openedDeliveryIds.size / deliveryCount,
      };
    })
    .sort((a, b) => a.actionRate - b.actionRate);
};

/**
 * The plan's own "alert types with low action rates are surfaced for threshold tuning" made
 * mechanically real — a plain threshold comparison, never a magic constant hidden in a component.
 * Requires a minimum sample size so a rule type with 1 notification and 0 actions doesn't get
 * flagged off a single data point.
 */
export const LOW_ACTION_RATE_THRESHOLD = 0.2;
export const MIN_SAMPLE_SIZE_FOR_TUNING = 5;

export const findRuleTypesNeedingTuning = (rates: ActionRateByType[]): ActionRateByType[] =>
  rates.filter((r) => r.notificationCount >= MIN_SAMPLE_SIZE_FOR_TUNING && r.actionRate < LOW_ACTION_RATE_THRESHOLD);
