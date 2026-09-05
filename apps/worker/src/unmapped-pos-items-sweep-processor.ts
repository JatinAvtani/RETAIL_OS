import { Decimal } from 'decimal.js';
import {
  createDb,
  findActiveStoresForScheduling,
  findOpenNotificationsByDedupPrefix,
  NotificationRepository,
  NotificationRuleRepository,
  PosItemRepository,
  type UnmappedPosItemWithVolume,
} from '@retailos/db';
import {
  aggregateNotificationContent,
  buildUnmappedPosItemsDedupKey,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  evaluateUnmappedPosItems,
  formatUnmappedPosItemsBody,
  formatUnmappedPosItemsTitle,
  resolveApplicableRule,
  resolveDedupAction,
  type AlertSeverity,
  type CandidateRule,
} from '@retailos/domain';
import { notifyRecipients } from './notification-fanout';

/**
 * `unmapped_pos_items`'s real trigger — a scheduled sweep, matching `lot-expiry-sweep-processor.ts`'s
 * own reasoning: there is no "an item just became unmapped" outbox event (a POS catalog sync only
 * ever creates a new `pos_items` row at `mappingStatus: 'UNMAPPED'`, it does not emit an event
 * naming the fact separately). `findUnmappedRankedByVolume` (`packages/db`, already built for the
 * mapping-UI's own read path) already does the real detection work — this processor adds nothing
 * on top except turning the existing per-store list into a real, aggregated notification (I2: one
 * "what counts as unmapped" definition, not a second one re-implemented here).
 *
 * Grouped per store — the SAME "N items -> 1 notification" shape `lot_expiring` established
 * (`aggregateNotificationContent`), since a manager cares about "you have 12 unmapped items worth
 * $450 in unattributed sales," not 12 separate alerts. `dollarImpact` per item is each item's own
 * real trailing revenue (`totalRevenue`) — `null` only when the query's own COALESCE reports a
 * genuine `'0'` for a never-sold item, which this processor still treats as a real, priced $0, not
 * an unknown (the query's own doc comment already establishes this is an unambiguous zero, not a
 * missing value).
 */
export const createUnmappedPosItemsSweepProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  return async (): Promise<{ notified: number; storesEvaluated: number; resolved: number }> => {
    const activeStores = await findActiveStoresForScheduling(db);

    let notified = 0;
    const evaluatedDedupKeys = new Set<string>();

    for (const store of activeStores) {
      try {
        const posItemRepo = new PosItemRepository(db, store.organizationId);
        const unmapped = await posItemRepo.findUnmappedRankedByVolume(store.storeId);

        const dedupKey = buildUnmappedPosItemsDedupKey(store.storeId);
        const created = await evaluateStoreGroup(db, config.redisUrl, store.organizationId, store.storeId, unmapped);
        if (created) notified += 1;
        evaluatedDedupKeys.add(dedupKey);
      } catch (error) {
        // One store's evaluation failing (a transient DB error) must not abort every other real
        // store already handled in this same tick.
        console.error(`Unmapped POS items sweep: failed to evaluate store ${store.organizationId}/${store.storeId}`, error);
      }
    }

    // A store whose unmapped backlog has since been fully mapped/ignored (or a store this tick
    // simply threw before reaching evaluatedDedupKeys.add) has nothing above calling
    // `resolveDedupAction` with `fires: false` for it — matching every other sweep's identical
    // stale-notification-resolution fix.
    const resolved = await resolveStaleNotifications(db, evaluatedDedupKeys);

    return { notified, storesEvaluated: activeStores.length, resolved };
  };
};

const resolveStaleNotifications = async (db: ReturnType<typeof createDb>['db'], evaluatedDedupKeys: Set<string>): Promise<number> => {
  const openNotifications = await findOpenNotificationsByDedupPrefix(db, 'unmapped_pos_items');
  let resolved = 0;
  for (const notification of openNotifications) {
    if (evaluatedDedupKeys.has(notification.dedupKey)) continue;
    try {
      const notificationRepo = new NotificationRepository(db, notification.organizationId);
      await notificationRepo.markResolved(notification.id);
      resolved += 1;
    } catch (error) {
      console.error(`Unmapped POS items sweep: failed to resolve stale notification ${notification.id} (org ${notification.organizationId})`, error);
    }
  }
  return resolved;
};

const evaluateStoreGroup = async (
  db: ReturnType<typeof createDb>['db'],
  redisUrl: string,
  organizationId: string,
  storeId: string,
  unmapped: UnmappedPosItemWithVolume[]
): Promise<boolean> => {
  const ruleRepo = new NotificationRuleRepository(db, organizationId);
  const candidates = (await ruleRepo.findEnabledByType('unmapped_pos_items')) as CandidateRule[];
  const applicableRule = resolveApplicableRule(candidates, storeId);
  const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.unmapped_pos_items;

  const evaluation = evaluateUnmappedPosItems(unmapped.length, { storeId }, severity);

  const notificationRepo = new NotificationRepository(db, organizationId);
  const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
  const action = resolveDedupAction(evaluation.fires, existing);

  switch (action.kind) {
    case 'CREATE':
    case 'UPDATE': {
      const rule = applicableRule ?? (await ruleRepo.create({
        ruleType: 'unmapped_pos_items',
        severity: DEFAULT_SEVERITY_BY_RULE_TYPE.unmapped_pos_items,
        threshold: {},
        recipientRoles: ['MANAGER'],
        channels: ['EMAIL'],
      })) as { id: string };
      const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
      const channels = applicableRule?.channels ?? ['EMAIL'];

      const content = aggregateNotificationContent(
        unmapped.map((item) => ({
          label: item.name,
          dollarImpact: new Decimal(item.totalRevenue),
          severity: evaluation.severity,
        })),
        formatUnmappedPosItemsTitle,
        formatUnmappedPosItemsBody
      );

      const { id: notificationId } = await notificationRepo.upsertByDedupKey({
        storeId,
        ruleId: rule.id,
        severity: content.severity,
        title: content.title,
        body: content.body,
        dedupKey: evaluation.dedupKey,
        aggregationGroup: evaluation.dedupKey,
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
