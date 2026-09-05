import {
  createDb,
  findActiveStoresForScheduling,
  findOpenNotificationsByDedupPrefix,
  NotificationRepository,
  NotificationRuleRepository,
} from '@retailos/db';
import {
  DEFAULT_MARGIN_DROP_THRESHOLD,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  evaluateMarginDrop,
  resolveApplicableRule,
  resolveDedupAction,
  resolveLocalDate,
  type AlertSeverity,
  type CandidateRule,
  type MarginDropThreshold,
  type StoreTimezone,
} from '@retailos/domain';
import { ALL_PERMISSIONS, type AuthContext } from '@retailos/authz';
import { executeMetric, MetricPermissionDeniedError, type MetricContext } from '@retailos/metrics';
import { notifyRecipients } from './notification-fanout';

const WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `margin_drop`'s real trigger — a scheduled sweep, matching `sales-anomaly-sweep-processor.ts`'s
 * own reasoning: no outbox event fires "contribution margin just fell," the fact only exists once
 * two real periods have actually happened. Compares each store's trailing 7 days (the "comparison"
 * period, ending yesterday in the store's own local time) against the 7 days before that (the
 * "base" period) — a rolling week-over-week check, chosen over a single-day comparison so ordinary
 * day-to-day noise (a slow Tuesday) doesn't fire on its own; a real week-over-week slip is a much
 * stronger signal a manager should see.
 *
 * Reuses the ALREADY-REGISTERED `contribution_margin_percentage` metric for both periods and
 * `margin_attribution` for the real dollar figure to report (I2 — margin computation lives in
 * exactly one place; this processor only compares two already-computed values and turns a real drop
 * into a notification, the same "detection lives in one place, this file only alerts on it" split
 * `lot-expiry-sweep-processor.ts`/`sales-anomaly-sweep-processor.ts` already established).
 */
export const createMarginDropSweepProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  return async (): Promise<{ notified: number; storesEvaluated: number; resolved: number }> => {
    const activeStores = await findActiveStoresForScheduling(db);
    const now = new Date();

    let notified = 0;
    const evaluatedDedupKeys = new Set<string>();

    for (const store of activeStores) {
      try {
        const timezone = store.timezone as StoreTimezone;
        const comparisonPeriodEndLocalDate = resolveLocalDate(new Date(now.getTime() - DAY_MS), timezone);

        const comparisonTo = now;
        const comparisonFrom = new Date(comparisonTo.getTime() - WINDOW_DAYS * DAY_MS);
        const baseTo = comparisonFrom;
        const baseFrom = new Date(baseTo.getTime() - WINDOW_DAYS * DAY_MS);

        const auth: AuthContext = {
          userId: 'system-margin-drop-sweep',
          organizationId: store.organizationId,
          storeIds: 'ALL',
          role: 'OWNER',
          permissions: new Set(ALL_PERMISSIONS),
        };
        const metricCtx: MetricContext = { db, organizationId: store.organizationId, storeIds: 'ALL' };

        let basePctResult, comparisonPctResult, attributionResult;
        try {
          [basePctResult, comparisonPctResult, attributionResult] = await Promise.all([
            executeMetric('contribution_margin_percentage', { storeId: store.storeId, from: baseFrom, to: baseTo }, auth, metricCtx),
            executeMetric('contribution_margin_percentage', { storeId: store.storeId, from: comparisonFrom, to: comparisonTo }, auth, metricCtx),
            executeMetric(
              'margin_attribution',
              { storeId: store.storeId, basePeriod: { from: baseFrom, to: baseTo }, comparisonPeriod: { from: comparisonFrom, to: comparisonTo } },
              auth,
              metricCtx
            ),
          ]);
        } catch (error) {
          if (error instanceof MetricPermissionDeniedError) continue;
          throw error;
        }

        const basePercentage = basePctResult.value === 'unknown' ? null : (basePctResult.value as string);
        const comparisonPercentage = comparisonPctResult.value === 'unknown' ? null : (comparisonPctResult.value as string);
        const dollarChange = attributionResult.value === 'unknown' ? null : (attributionResult.value as string);

        const ruleRepo = new NotificationRuleRepository(db, store.organizationId);
        const candidates = (await ruleRepo.findEnabledByType('margin_drop')) as CandidateRule[];
        const applicableRule = resolveApplicableRule(candidates, store.storeId);
        const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.margin_drop;
        const threshold = resolveMarginDropThreshold(applicableRule?.threshold);

        const evaluation = evaluateMarginDrop(
          { basePercentage, comparisonPercentage, dollarChange },
          { storeId: store.storeId, comparisonPeriodEndLocalDate },
          threshold,
          severity
        );

        const created = await applyEvaluation(
          db,
          config.redisUrl,
          store.organizationId,
          store.storeId,
          evaluation,
          basePercentage,
          comparisonPercentage,
          ruleRepo,
          applicableRule
        );
        if (created) notified += 1;
        evaluatedDedupKeys.add(evaluation.dedupKey);
      } catch (error) {
        // One store's evaluation failing (a transient DB error, a malformed metric result) must not
        // abort every other real store already handled in this same tick.
        console.error(`Margin drop sweep: failed to evaluate store ${store.organizationId}/${store.storeId}`, error);
      }
    }

    // A store no longer showing a drop this tick (margin recovered, or yesterday rolled forward)
    // has nothing in the loop above calling `resolveDedupAction` with `fires: false` for its PRIOR
    // day's key — matching `sales-anomaly-sweep-processor.ts`'s identical stale-notification fix.
    const resolved = await resolveStaleNotifications(db, evaluatedDedupKeys);

    return { notified, storesEvaluated: activeStores.length, resolved };
  };
};

const resolveStaleNotifications = async (db: ReturnType<typeof createDb>['db'], evaluatedDedupKeys: Set<string>): Promise<number> => {
  const openNotifications = await findOpenNotificationsByDedupPrefix(db, 'margin_drop');
  let resolved = 0;
  for (const notification of openNotifications) {
    if (evaluatedDedupKeys.has(notification.dedupKey)) continue;
    try {
      const notificationRepo = new NotificationRepository(db, notification.organizationId);
      await notificationRepo.markResolved(notification.id);
      resolved += 1;
    } catch (error) {
      console.error(`Margin drop sweep: failed to resolve stale notification ${notification.id} (org ${notification.organizationId})`, error);
    }
  }
  return resolved;
};

const applyEvaluation = async (
  db: ReturnType<typeof createDb>['db'],
  redisUrl: string,
  organizationId: string,
  storeId: string,
  evaluation: ReturnType<typeof evaluateMarginDrop>,
  basePercentage: string | null,
  comparisonPercentage: string | null,
  ruleRepo: InstanceType<typeof NotificationRuleRepository>,
  applicableRule: CandidateRule | null
): Promise<boolean> => {
  const notificationRepo = new NotificationRepository(db, organizationId);
  const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
  const action = resolveDedupAction(evaluation.fires, existing);

  switch (action.kind) {
    case 'CREATE':
    case 'UPDATE': {
      const rule = applicableRule ?? (await ruleRepo.create({
        ruleType: 'margin_drop',
        severity: DEFAULT_SEVERITY_BY_RULE_TYPE.margin_drop,
        threshold: DEFAULT_MARGIN_DROP_THRESHOLD,
        recipientRoles: ['MANAGER'],
        channels: ['EMAIL'],
      })) as { id: string };
      const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
      const channels = applicableRule?.channels ?? ['EMAIL'];

      const { id: notificationId } = await notificationRepo.upsertByDedupKey({
        storeId,
        ruleId: rule.id,
        severity: evaluation.severity,
        title: 'Contribution margin dropped',
        body: `Contribution margin fell from ${Number(basePercentage).toFixed(1)}% to ${Number(comparisonPercentage).toFixed(1)}% of net revenue over the trailing week.`,
        dedupKey: evaluation.dedupKey,
        entityType: 'store',
        entityId: storeId,
        ...(evaluation.dollarImpact !== null ? { dollarImpact: evaluation.dollarImpact.toFixed(4) } : {}),
      });

      if (action.kind === 'CREATE') {
        await notifyRecipients(db, redisUrl, organizationId, notificationId, storeId, evaluation.severity, recipientRoles, channels);
      }
      return true;
    }
    case 'RESOLVE':
      await notificationRepo.markResolved(action.existingId);
      return false;
    case 'NO_OP':
      return false;
  }
};

/**
 * Narrows a tenant-configured `notification_rules.threshold` (stored as `unknown` JSON) to the one
 * field `evaluateMarginDrop` reads, falling back to the catalogue default on anything missing or
 * malformed — matching `lot-expiry-sweep-processor.ts`'s identical `resolveLotExpiringThreshold`
 * pattern. Never throws on a bad value: one tenant's malformed config must not break every other
 * tenant's sweep in the same tick.
 */
const resolveMarginDropThreshold = (threshold: unknown): MarginDropThreshold => {
  if (
    threshold !== null &&
    typeof threshold === 'object' &&
    'minPercentagePointDrop' in threshold &&
    typeof (threshold as { minPercentagePointDrop: unknown }).minPercentagePointDrop === 'number'
  ) {
    return { minPercentagePointDrop: (threshold as { minPercentagePointDrop: number }).minPercentagePointDrop };
  }
  return DEFAULT_MARGIN_DROP_THRESHOLD;
};
