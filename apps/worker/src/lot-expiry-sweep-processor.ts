import { Decimal } from 'decimal.js';
import {
  createDb,
  findActiveStoresForScheduling,
  findExpiryQueue,
  findOpenNotificationsByDedupPrefix,
  NotificationRepository,
  NotificationRuleRepository,
  type ExpiryQueueRow,
} from '@retailos/db';
import {
  aggregateNotificationContent,
  buildExpiryDedupKey,
  DEFAULT_LOT_EXPIRING_THRESHOLD,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  evaluateLotExpiring,
  formatLotExpiringBody,
  formatLotExpiringTitle,
  resolveApplicableRule,
  resolveDedupAction,
  resolveLocalDate,
  type AlertSeverity,
  type CandidateRule,
} from '@retailos/domain';
import { notifyRecipients } from './notification-fanout';

/**
 * `lot_expiring`'s real trigger — a scheduled sweep, not an event, matching this module's own
 * documented reasoning in `rule-evaluation-processor.ts`: no outbox event fires "a lot is now N
 * days from expiry," time simply passes. Built on the exact same shape as
 * `briefing-schedule-poll-processor.ts` (a periodic tick sweeping every active store), but as ONE
 * repeatable job rather than a two-stage poll-then-per-store-cron pair — `lot_expiring` has no
 * "must land at exactly 06:00 store-local" requirement the way the daily briefing does (the plan's
 * own risk callout was specific to the briefing), so a plain interval tick that re-evaluates every
 * active store's current expiry queue is the simplest correct mechanism, not a simplification that
 * drops real behavior.
 *
 * `findExpiryQueue` (`packages/db`) already does the real detection work — real lot cost, real
 * FEFO-consistent "ACTIVE, remaining_quantity > 0, has an expiry_date" filtering, and the real
 * consumption-cover-vs-days-to-expiry at-risk gate (I2/I7, see that function's own doc comment).
 * This processor adds exactly one more gate on top (`evaluateLotExpiring`'s configurable
 * `withinDays` window) and turns the result into real notifications — it does not re-derive
 * at-risk detection itself.
 *
 * Grouped per (organization, store, store-LOCAL date) — the plan's own worked example ("5 expiring
 * lots -> 1 notification, not 5") via `aggregateNotificationContent`, using each row's OWN
 * `dollarImpact` (`valueAtRisk`, already a real cost×quantity figure from `findExpiryQueue`, I7-safe
 * — never synthesized here).
 */
export const createLotExpirySweepProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  return async (): Promise<{ notified: number; groups: number; resolved: number }> => {
    const asOf = new Date();
    const [queue, activeStores] = await Promise.all([findExpiryQueue(db, asOf), findActiveStoresForScheduling(db)]);

    const timezoneByStoreId = new Map(activeStores.map((s) => [s.storeId, s.timezone]));

    // Group by (organizationId, storeId, store-LOCAL date) — a lot's own store resolves its own
    // timezone for "today," matching every other store-scoped local-date computation in this
    // codebase (never a single global "today").
    const groups = new Map<string, { organizationId: string; storeId: string; localDate: string; rows: ExpiryQueueRow[] }>();
    for (const row of queue) {
      const timezone = timezoneByStoreId.get(row.storeId) ?? 'UTC';
      const localDate = resolveLocalDate(asOf, timezone);
      const key = `${row.organizationId}:${row.storeId}:${localDate}`;
      const existing = groups.get(key);
      if (existing) {
        existing.rows.push(row);
      } else {
        groups.set(key, { organizationId: row.organizationId, storeId: row.storeId, localDate, rows: [row] });
      }
    }

    let notified = 0;
    const evaluatedDedupKeys = new Set<string>();
    for (const group of groups.values()) {
      const dedupKey = buildExpiryDedupKey(group.storeId, group.localDate);
      try {
        const created = await evaluateGroup(db, config.redisUrl, group);
        if (created) notified += 1;
        // Reached only once `evaluateGroup` completed without throwing — a group that threw must
        // NOT be treated as "evaluated this tick," or a real transient failure would incorrectly
        // resolve an otherwise-still-open notification below.
        evaluatedDedupKeys.add(dedupKey);
      } catch (error) {
        // One store's/org's evaluation failing (a bad row, a transient DB error) must not abort
        // every other real group already resolved in this same tick — matching
        // `briefingSchedulePollProcessor`'s own per-store try/catch precedent.
        console.error(`Lot expiry sweep: failed to evaluate group ${group.organizationId}/${group.storeId}/${group.localDate}`, error);
      }
    }

    // `queue` only ever contains lots `findExpiryQueue` currently considers at-risk — a
    // (store, local-date) group whose every lot has since been consumed, wasted, or genuinely
    // expired simply disappears from `groups` above, so nothing in the loop above ever calls
    // `resolveDedupAction` with `fires: false` for it and its open notification would stay open
    // forever. This is the other half: every still-open `lot_expiring` notification this tick did
    // NOT just re-evaluate (whether because the group no longer exists, or because it threw) gets
    // resolved here — matching `negative-stock-sweep-processor.ts`'s identical fix.
    const resolved = await resolveStaleNotifications(db, evaluatedDedupKeys);

    return { notified, groups: groups.size, resolved };
  };
};

/**
 * `lots.remaining_quantity` is `numeric(19,6)`, so postgres-js hands it back as a fixed-scale
 * string ("150000.000000"). That scale is real precision the ledger needs and noise a person
 * doesn't — this drops only trailing zeros, never a significant digit, so an exact quantity stays
 * exact. Deliberately string-only (no `Number()` round trip), since a large quantity would lose
 * precision through a float.
 */
const formatLedgerQuantity = (raw: string): string =>
  raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;

const resolveStaleNotifications = async (db: ReturnType<typeof createDb>['db'], evaluatedDedupKeys: Set<string>): Promise<number> => {
  const openNotifications = await findOpenNotificationsByDedupPrefix(db, 'expiry');
  let resolved = 0;
  for (const notification of openNotifications) {
    if (evaluatedDedupKeys.has(notification.dedupKey)) continue;
    try {
      const notificationRepo = new NotificationRepository(db, notification.organizationId);
      await notificationRepo.markResolved(notification.id);
      resolved += 1;
    } catch (error) {
      // One stale notification failing to resolve (a transient DB error) must not stop every
      // other genuinely-recovered group in this same tick from being resolved.
      console.error(`Lot expiry sweep: failed to resolve stale notification ${notification.id} (org ${notification.organizationId})`, error);
    }
  }
  return resolved;
};

const evaluateGroup = async (
  db: ReturnType<typeof createDb>['db'],
  redisUrl: string,
  group: { organizationId: string; storeId: string; localDate: string; rows: ExpiryQueueRow[] }
): Promise<boolean> => {
  const { organizationId, storeId, localDate, rows } = group;

  const ruleRepo = new NotificationRuleRepository(db, organizationId);
  const candidates = (await ruleRepo.findEnabledByType('lot_expiring')) as CandidateRule[];
  const applicableRule = resolveApplicableRule(candidates, storeId);
  const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.lot_expiring;
  const threshold = resolveLotExpiringThreshold(applicableRule?.threshold);

  const evaluations = rows.map((row) => ({
    row,
    result: evaluateLotExpiring(
      { valueAtRisk: new Decimal(row.valueAtRisk), daysToExpiry: row.daysToExpiry },
      { storeId, localDate },
      threshold,
      severity
    ),
  }));
  const firingRows = evaluations.filter((e) => e.result.fires);

  const dedupKey = buildExpiryDedupKey(storeId, localDate);
  const notificationRepo = new NotificationRepository(db, organizationId);
  const existing = await notificationRepo.findOpenByDedupKey(dedupKey);
  const action = resolveDedupAction(firingRows.length > 0, existing);

  switch (action.kind) {
    case 'CREATE':
    case 'UPDATE': {
      const rule = applicableRule ?? (await ruleRepo.create({
        ruleType: 'lot_expiring',
        severity: DEFAULT_SEVERITY_BY_RULE_TYPE.lot_expiring,
        threshold: {},
        recipientRoles: ['MANAGER'],
        channels: ['EMAIL'],
      })) as { id: string };
      const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
      const channels = applicableRule?.channels ?? ['EMAIL'];

      const content = aggregateNotificationContent(
        firingRows.map((e) => ({
          // A person reads this text — so it names the product, not its uuid, and trims the
          // ledger's fixed 6-decimal scale down to the digits that carry meaning. The previous
          // form ("150000.000000 of product 01a054db-… (lot 01a0562d-…)") was a debug dump
          // rendered straight into a user-facing body. `productName` is null only when the
          // product row is genuinely gone; that degrades to the id rather than inventing a name.
          label: `${formatLedgerQuantity(e.row.remainingQuantity)} of ${e.row.productName ?? `product ${e.row.productId}`}`,
          dollarImpact: new Decimal(e.row.valueAtRisk),
          severity: e.result.severity,
        })),
        formatLotExpiringTitle,
        formatLotExpiringBody
      );

      const { id: notificationId } = await notificationRepo.upsertByDedupKey({
        storeId,
        ruleId: rule.id,
        severity: content.severity,
        title: content.title,
        body: content.body,
        dedupKey,
        aggregationGroup: dedupKey,
        entityType: 'store',
        entityId: storeId,
        ...(content.totalDollarImpact !== null ? { dollarImpact: content.totalDollarImpact.toFixed(4) } : {}),
      });

      if (action.kind === 'CREATE') {
        await notifyRecipients(db, redisUrl, organizationId, notificationId, storeId, content.severity, recipientRoles, channels);
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
 * A tenant-configured `notification_rules.threshold` is stored as `unknown` JSON — this narrows it
 * to the one field `evaluateLotExpiring` actually reads (`withinDays`), falling back to the
 * catalogue default whenever the stored shape is missing, malformed, or simply absent (no rule
 * configured yet). Never throws on a malformed value — a tenant's bad config data must not break
 * every other tenant's sweep in the same tick.
 */
const resolveLotExpiringThreshold = (threshold: unknown): { withinDays: number } => {
  if (
    threshold !== null &&
    typeof threshold === 'object' &&
    'withinDays' in threshold &&
    typeof (threshold as { withinDays: unknown }).withinDays === 'number'
  ) {
    return { withinDays: (threshold as { withinDays: number }).withinDays };
  }
  return DEFAULT_LOT_EXPIRING_THRESHOLD;
};
