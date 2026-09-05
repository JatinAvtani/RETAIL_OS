import { Decimal } from 'decimal.js';
import {
  createDb,
  findActiveStoresForScheduling,
  findOpenNotificationsByDedupPrefix,
  DashboardRepository,
  NotificationRepository,
  NotificationRuleRepository,
} from '@retailos/db';
import {
  buildSalesAnomalyDedupKey,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  evaluateSalesAnomaly,
  resolveApplicableRule,
  resolveDedupAction,
  type AlertSeverity,
  type CandidateRule,
} from '@retailos/domain';
import { ALL_PERMISSIONS, type AuthContext } from '@retailos/authz';
import { executeMetric, MetricPermissionDeniedError, type MetricContext } from '@retailos/metrics';
import { notifyRecipients } from './notification-fanout';

const ANOMALY_WINDOW_DAYS = 30;

/**
 * `sales_anomaly`'s real trigger — a scheduled sweep, matching `lot-expiry-sweep-processor.ts`'s
 * own reasoning: no outbox event fires "today's revenue is now a statistical outlier," the fact
 * only exists once enough of the trailing window has actually happened. Reuses the ALREADY-
 * REGISTERED `sales_anomaly` metric (`packages/metrics/src/anomaly/catalog-entries.ts`) — the real
 * seasonal-decomposition z-score test lives there, exactly once (I2); this processor's only job is
 * turning an already-flagged day into a real notification, the same "detection lives in one place,
 * this file only alerts on it" split `findExpiryQueue`/`findNegativeStock` already established.
 *
 * Executes the metric under a synthetic OWNER-equivalent `AuthContext` (`ALL_PERMISSIONS`,
 * matching `briefing-processor.ts`'s own precedent) — there is no real logged-in caller when a
 * scheduled job fires. `MetricPermissionDeniedError` is treated as "skip this store, not a sweep
 * failure" the same way `briefing-processor.ts`'s own `tryMetric` helper does, though with
 * `ALL_PERMISSIONS` it should never actually fire — kept as defense in depth, not dead code
 * removal, since a future permission-model change should degrade gracefully here too.
 *
 * One notification PER (store, flagged day) — unlike `lot_expiring`'s "N lots -> 1 notification"
 * aggregation, a sales anomaly has no natural grouping key beyond the day itself (there is exactly
 * one revenue figure per store per day, never multiple candidate rows to aggregate), so
 * `evaluateSalesAnomaly` is called once per flagged day directly, matching `stock_below_reorder`'s
 * own per-item granularity precedent instead.
 */
export const createSalesAnomalySweepProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  return async (): Promise<{ notified: number; storesEvaluated: number; resolved: number }> => {
    const activeStores = await findActiveStoresForScheduling(db);
    const to = new Date();
    const from = new Date(to.getTime() - ANOMALY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    let notified = 0;
    const evaluatedDedupKeys = new Set<string>();

    for (const store of activeStores) {
      try {
        const auth: AuthContext = {
          userId: 'system-sales-anomaly-sweep',
          organizationId: store.organizationId,
          storeIds: 'ALL',
          role: 'OWNER',
          permissions: new Set(ALL_PERMISSIONS),
        };
        const metricCtx: MetricContext = { db, organizationId: store.organizationId, storeIds: 'ALL' };

        let result;
        try {
          result = await executeMetric('sales_anomaly', { storeId: store.storeId, from, to }, auth, metricCtx);
        } catch (error) {
          if (error instanceof MetricPermissionDeniedError) continue;
          throw error;
        }

        // A real `'unknown'` result (fewer than 14 days of sales history — see the metric's own
        // doc comment) has no anomalies to report; genuinely different from "zero anomalies found"
        // but both cases mean nothing fires for this store this tick.
        const anomalies = 'anomalies' in result ? (result as { anomalies: { date: string; value: string; zScore: string }[] }).anomalies : [];
        if (anomalies.length === 0) continue;

        // `FlaggedPoint.value` is the decomposition's own RESIDUAL (actual - trend - seasonal), a
        // real statistical magnitude but not a figure a manager reads as "today's revenue" — a
        // second, independent lookup of the same real `sales_transactions` data
        // (`findDailyGrossRevenue`, the metric's own data source, I2: not a re-derivation of the
        // anomaly test itself) gets the actual raw revenue for each flagged date so the
        // notification states something directly meaningful ("revenue was $500"), not a residual
        // the recipient has no context to interpret.
        const dashboardRepo = new DashboardRepository(db, store.organizationId);
        const dailyRevenueRows = await dashboardRepo.findDailyGrossRevenue(store.storeId, from, to);
        const actualRevenueByDate = new Map(dailyRevenueRows.map((r) => [r.date, r.totalSubtotal]));

        const ruleRepo = new NotificationRuleRepository(db, store.organizationId);
        const candidates = (await ruleRepo.findEnabledByType('sales_anomaly')) as CandidateRule[];
        const applicableRule = resolveApplicableRule(candidates, store.storeId);
        const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.sales_anomaly;

        for (const anomaly of anomalies) {
          // The real revenue row for this exact flagged date always exists — `anomalies` is itself
          // derived from the same `dailyRevenueRows` series inside the metric, so a date present in
          // one is present in the other by construction; falling back to the residual is defensive
          // only, never expected to fire in practice.
          const actualRevenue = actualRevenueByDate.get(anomaly.date) ?? anomaly.value;
          const created = await evaluateAnomalyDay(db, config.redisUrl, store.organizationId, store.storeId, anomaly, actualRevenue, severity, ruleRepo, applicableRule);
          if (created) notified += 1;
          evaluatedDedupKeys.add(buildSalesAnomalyDedupKey(store.storeId, anomaly.date));
        }
      } catch (error) {
        // One store's evaluation failing (a transient DB error, a malformed metric result) must not
        // abort every other real store already handled in this same tick.
        console.error(`Sales anomaly sweep: failed to evaluate store ${store.organizationId}/${store.storeId}`, error);
      }
    }

    // A day that WAS flagged on a prior sweep but is no longer in the metric's own flagged set
    // (the trailing window moved past it, or a correction to sales data resolved the outlier) has
    // nothing in this tick's loop above calling `resolveDedupAction` with `fires: false` for it —
    // matching `lot-expiry-sweep-processor.ts`'s identical stale-notification-resolution fix.
    const resolved = await resolveStaleNotifications(db, evaluatedDedupKeys);

    return { notified, storesEvaluated: activeStores.length, resolved };
  };
};

const resolveStaleNotifications = async (db: ReturnType<typeof createDb>['db'], evaluatedDedupKeys: Set<string>): Promise<number> => {
  const openNotifications = await findOpenNotificationsByDedupPrefix(db, 'sales_anomaly');
  let resolved = 0;
  for (const notification of openNotifications) {
    if (evaluatedDedupKeys.has(notification.dedupKey)) continue;
    try {
      const notificationRepo = new NotificationRepository(db, notification.organizationId);
      await notificationRepo.markResolved(notification.id);
      resolved += 1;
    } catch (error) {
      console.error(`Sales anomaly sweep: failed to resolve stale notification ${notification.id} (org ${notification.organizationId})`, error);
    }
  }
  return resolved;
};

const evaluateAnomalyDay = async (
  db: ReturnType<typeof createDb>['db'],
  redisUrl: string,
  organizationId: string,
  storeId: string,
  anomaly: { date: string; value: string; zScore: string },
  actualRevenue: string,
  severity: AlertSeverity,
  ruleRepo: InstanceType<typeof NotificationRuleRepository>,
  applicableRule: CandidateRule | null
): Promise<boolean> => {
  const evaluation = evaluateSalesAnomaly({ date: anomaly.date, actualRevenue, zScore: anomaly.zScore }, { storeId }, severity);

  const notificationRepo = new NotificationRepository(db, organizationId);
  const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
  const action = resolveDedupAction(evaluation.fires, existing);

  switch (action.kind) {
    case 'CREATE':
    case 'UPDATE': {
      const rule = applicableRule ?? (await ruleRepo.create({
        ruleType: 'sales_anomaly',
        severity: DEFAULT_SEVERITY_BY_RULE_TYPE.sales_anomaly,
        threshold: {},
        recipientRoles: ['MANAGER'],
        channels: ['EMAIL'],
      })) as { id: string };
      const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
      const channels = applicableRule?.channels ?? ['EMAIL'];

      const { id: notificationId } = await notificationRepo.upsertByDedupKey({
        storeId,
        ruleId: rule.id,
        severity: evaluation.severity,
        title: 'Unusual sales pattern detected',
        body: `Revenue on ${anomaly.date} (${new Decimal(actualRevenue).toFixed(2)}) was a statistical outlier (z-score ${new Decimal(anomaly.zScore).toFixed(2)}) against this store's own trend and day-of-week pattern.`,
        dedupKey: evaluation.dedupKey,
        entityType: 'store',
        entityId: storeId,
        dollarImpact: evaluation.dollarImpact.toFixed(4),
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
