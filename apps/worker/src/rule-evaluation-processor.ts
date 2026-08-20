import type { Job } from 'bullmq';
import { Decimal } from 'decimal.js';
import {
  NotificationRepository,
  NotificationRuleRepository,
  ParLevelRepository,
  StockLevelRepository,
  createDb,
} from '@retailos/db';
import {
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  evaluateStockBelowReorder,
  resolveApplicableRule,
  resolveDedupAction,
  type AlertSeverity,
  type CandidateRule,
} from '@retailos/domain';
import type { RelayJobData } from '@retailos/queue';

/**
 * The real first consumer of the outbox relay — turns a relayed domain event into a real rule
 * evaluation, closing the loop `packages/domain`'s `resolveDedupAction`/
 * `evaluateStockBelowReorder` built with no caller yet. A thin adapter, matching
 * `createExtractionProcessor`'s established shape: BullMQ/event plumbing here, the actual decision
 * logic lives in `@retailos/domain`'s pure functions.
 *
 * Scoped to `stock_below_reorder` only for now — the other alert types each need their own real
 * trigger wiring (`lot_expiring` in particular needs a scheduled sweep, not an event-triggered
 * check: no outbox event fires "a lot is now N days from expiry," time simply passes — a
 * genuinely different mechanism from this event-driven scope, deliberately left for later rather
 * than bolted on here). `stock.moved` is the one real event this codebase emits today that a
 * `stock_below_reorder` re-check can act on directly.
 */
export const createRuleEvaluationProcessor = (config: { databaseUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  const evaluateStockBelowReorderFromEvent = async (event: RelayJobData): Promise<void> => {
    const payload = event.payload as { storeId?: unknown; productId?: unknown; variantId?: unknown };
    if (typeof payload.storeId !== 'string' || typeof payload.productId !== 'string' || typeof payload.variantId !== 'string') {
      // A malformed/unexpected stock.moved payload shape — skip rather than throw, since a bad
      // shape here is a data problem this processor cannot fix by retrying, and retrying
      // indefinitely on a permanently-malformed payload would just fill the DLQ pointlessly.
      console.error(`Rule evaluation: stock.moved event ${event.outboxEventId} has an unexpected payload shape`, event.payload);
      return;
    }
    const { storeId, productId, variantId } = payload;

    const stockLevelRepo = new StockLevelRepository(db, event.organizationId);
    const parLevelRepo = new ParLevelRepository(db, event.organizationId);

    const [stockLevel, parLevel] = await Promise.all([
      stockLevelRepo.find(storeId, productId, variantId),
      parLevelRepo.find(storeId, productId, variantId),
    ]);

    // No reorder point configured for this item at all — genuinely nothing to evaluate against,
    // not an "unknown" that should still surface a notification (I7: a missing threshold is a
    // configuration gap, not a fired alert).
    if (!parLevel?.reorderPoint) return;
    // No stock_levels row yet (a brand-new product with zero movements ever) — nothing on hand to
    // compare, same reasoning.
    if (!stockLevel) return;

    const ruleRepo = new NotificationRuleRepository(db, event.organizationId);
    const candidates = (await ruleRepo.findEnabledByType('stock_below_reorder')) as CandidateRule[];
    const applicableRule = resolveApplicableRule(candidates, storeId);
    const severity: AlertSeverity = (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.stock_below_reorder;

    const evaluation = evaluateStockBelowReorder(
      { quantityOnHand: new Decimal(stockLevel.quantity), reorderPoint: new Decimal(parLevel.reorderPoint) },
      { storeId, productId, variantId },
      severity
    );

    const notificationRepo = new NotificationRepository(db, event.organizationId);
    const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
    const action = resolveDedupAction(evaluation.fires, existing);

    switch (action.kind) {
      case 'CREATE':
      case 'UPDATE': {
        // `notifications.rule_id` is NOT NULL, so a firing notification always needs a real row to
        // reference — confirmed with the user: when the tenant has configured NOTHING for this
        // rule type (`resolveApplicableRule` returned `null`), auto-provision a real
        // `notification_rules` row from the catalogue default (severity, a sensible
        // recipientRoles/channels pairing) THE FIRST TIME it's needed, rather than skipping
        // persistence — this is what makes the "sensible defaults... never silently skip
        // evaluation for lack of configuration" promise real at the persistence layer, not just in
        // the pure function's own tests. Every later fire of the same (org, ruleType) reuses this
        // now-real row via `findEnabledByType`/`resolveApplicableRule`, same as any other
        // tenant-configured rule; a tenant can see/edit it once the notification centre exists.
        const ruleId = applicableRule?.id ?? (await ruleRepo.create({
          ruleType: 'stock_below_reorder',
          severity: DEFAULT_SEVERITY_BY_RULE_TYPE.stock_below_reorder,
          threshold: {},
          recipientRoles: ['MANAGER'],
          channels: ['EMAIL'],
        })).id;

        await notificationRepo.upsertByDedupKey({
          storeId,
          ruleId,
          severity: evaluation.severity,
          title: `Stock below reorder point`,
          body: `Product ${productId} at store ${storeId} is at or below its configured reorder point.`,
          dedupKey: evaluation.dedupKey,
          entityType: 'product',
          entityId: productId,
        });
        break;
      }
      case 'RESOLVE':
        await notificationRepo.markResolved(action.existingId);
        break;
      case 'NO_OP':
        break;
    }
  };

  return async (job: Job<RelayJobData>): Promise<void> => {
    const event = job.data;
    switch (event.eventType) {
      case 'stock.moved':
        await evaluateStockBelowReorderFromEvent(event);
        return;
      default:
        // Every other relayed event type has no rule-evaluation mapping yet — a deliberate no-op,
        // not a dropped event: the relay itself already marked it published (its job is delivery,
        // not interpretation), and this processor's contract is "evaluate what I understand,
        // ignore what I don't" rather than throwing on an unrecognized type, which would retry
        // forever into the DLQ for an event this processor was never meant to act on.
        return;
    }
  };
};
