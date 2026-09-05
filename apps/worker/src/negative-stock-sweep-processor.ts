import { Decimal } from 'decimal.js';
import {
  createDb,
  findNegativeStock,
  findOpenNotificationsByDedupPrefix,
  NotificationRepository,
  NotificationRuleRepository,
} from '@retailos/db';
import {
  buildNegativeStockDedupKey,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  evaluateNegativeStock,
  resolveApplicableRule,
  resolveDedupAction,
  type AlertSeverity,
  type CandidateRule,
} from '@retailos/domain';
import { notifyRecipients } from './notification-fanout';

/**
 * `negative_stock`'s real trigger — a scheduled sweep, the same mechanism `lot_expiring` needs and
 * for the same reason: `findNegativeStock` (`packages/db`) is documented as "a signal, not an
 * error... a future worker job... decides what to do with the result" — there is no `stock.negative`
 * outbox event anywhere in this codebase to consume (the design names it, but emitting it was
 * explicitly left out of `MovementService`'s scope). A recurring sweep over the real
 * `stock_levels` projection is the real trigger this rule type has, not a fabricated event.
 *
 * `findNegativeStock` already IS the complete detection (I2: `quantity < 0` on the real projection,
 * no join, no threshold to configure) — this processor adds no second definition of "negative," it
 * only turns each already-found row into a real per-(store, product, variant) notification, one at
 * a time (unlike `lot_expiring`, the plan's own worked aggregation example is specific to expiring
 * lots; negative stock has no equivalent "N incidents -> 1 notification" precedent anywhere in this
 * codebase, so each (store, product, variant) gets its own dedup key/notification, matching
 * `stock_below_reorder`'s own per-item granularity instead).
 */
export const createNegativeStockSweepProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  return async (): Promise<{ notified: number; total: number; resolved: number }> => {
    const rows = await findNegativeStock(db);
    let notified = 0;
    const stillFiringDedupKeys = new Set<string>();

    for (const row of rows) {
      const dedupKey = buildNegativeStockDedupKey(row.storeId, row.productId, row.variantId);
      try {
        const created = await evaluateRow(db, config.redisUrl, row);
        if (created) notified += 1;
        // Reached only once `evaluateRow` completed without throwing — a row that threw must NOT
        // be treated as "still firing," or a real transient failure would incorrectly resolve an
        // otherwise-still-open notification below.
        stillFiringDedupKeys.add(dedupKey);
      } catch (error) {
        // One row's evaluation failing must not abort every other genuine negative-stock row
        // already found in this same sweep — matching every other per-item loop in this worker's
        // own established try/catch precedent.
        console.error(`Negative stock sweep: failed to evaluate ${row.organizationId}/${row.storeId}/${row.productId}/${row.variantId}`, error);
      }
    }

    // `findNegativeStock` only ever returns CURRENTLY negative rows — a row that recovered to
    // non-negative since the last tick simply disappears from `rows` above, so nothing in the loop
    // above ever calls `resolveDedupAction` with `fires: false` for it and its open notification
    // would stay open forever. This is the other half: every still-open `negative_stock`
    // notification this tick did NOT just re-confirm as firing gets resolved here.
    const resolved = await resolveStaleNotifications(db, stillFiringDedupKeys);

    return { notified, total: rows.length, resolved };
  };
};

const resolveStaleNotifications = async (db: ReturnType<typeof createDb>['db'], stillFiringDedupKeys: Set<string>): Promise<number> => {
  const openNotifications = await findOpenNotificationsByDedupPrefix(db, 'negative_stock');
  let resolved = 0;
  for (const notification of openNotifications) {
    if (stillFiringDedupKeys.has(notification.dedupKey)) continue;
    try {
      const notificationRepo = new NotificationRepository(db, notification.organizationId);
      await notificationRepo.markResolved(notification.id);
      resolved += 1;
    } catch (error) {
      // One stale notification failing to resolve (a transient DB error) must not stop every
      // other genuinely-recovered row in this same tick from being resolved.
      console.error(`Negative stock sweep: failed to resolve stale notification ${notification.id} (org ${notification.organizationId})`, error);
    }
  }
  return resolved;
};

const evaluateRow = async (
  db: ReturnType<typeof createDb>['db'],
  redisUrl: string,
  row: { organizationId: string; storeId: string; productId: string; variantId: string; quantityOnHand: string }
): Promise<boolean> => {
  const { organizationId, storeId, productId, variantId, quantityOnHand } = row;

  const ruleRepo = new NotificationRuleRepository(db, organizationId);
  const candidates = (await ruleRepo.findEnabledByType('negative_stock')) as CandidateRule[];
  const applicableRule = resolveApplicableRule(candidates, storeId);
  const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.negative_stock;

  const evaluation = evaluateNegativeStock({ quantityOnHand: new Decimal(quantityOnHand) }, { storeId, productId, variantId }, severity);

  const notificationRepo = new NotificationRepository(db, organizationId);
  const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
  const action = resolveDedupAction(evaluation.fires, existing);

  switch (action.kind) {
    case 'CREATE':
    case 'UPDATE': {
      const rule = applicableRule ?? (await ruleRepo.create({
        ruleType: 'negative_stock',
        severity: DEFAULT_SEVERITY_BY_RULE_TYPE.negative_stock,
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
        title: 'Negative stock detected',
        body: `Product ${productId} at store ${storeId} shows a negative on-hand quantity (${quantityOnHand}) — likely an unrecorded receipt.`,
        dedupKey: evaluation.dedupKey,
        entityType: 'product',
        entityId: productId,
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
