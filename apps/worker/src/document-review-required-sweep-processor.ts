import {
  createDb,
  findDocumentsReviewRequired,
  findOpenNotificationsByDedupPrefix,
  type DocumentReviewRequiredRow,
  NotificationRepository,
  NotificationRuleRepository,
} from '@retailos/db';
import {
  aggregateNotificationContent,
  buildDocumentReviewRequiredDedupKey,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  evaluateDocumentReviewRequired,
  formatDocumentReviewRequiredBody,
  formatDocumentReviewRequiredTitle,
  resolveApplicableRule,
  resolveDedupAction,
  type AlertSeverity,
  type CandidateRule,
} from '@retailos/domain';
import { notifyRecipients } from './notification-fanout';

/**
 * `document_review_required`'s real trigger — a scheduled sweep, the same reasoning as
 * `unmapped-pos-items-sweep-processor.ts`: there is no dedicated outbox event fired the moment a
 * document lands at `REVIEW_REQUIRED` (the ingestion pipeline only ever writes the status column
 * itself), so a periodic sweep is what surfaces it. `findDocumentsReviewRequired` (`packages/db`) is
 * a single cross-tenant `WHERE status = 'REVIEW_REQUIRED'` read on the real column the ingestion
 * pipeline already writes — no new "needs review" definition is introduced here (I2).
 *
 * Grouped per store, matching `unmapped_pos_items`'s own "N items -> 1 notification" shape
 * (`aggregateNotificationContent`) — a manager cares about "you have 3 documents waiting on
 * review," not 3 separate alerts. No dollar impact is ever attached (an unreviewed document has no
 * known cost until a human resolves it, I7).
 */
export const createDocumentReviewRequiredSweepProcessor = (config: { databaseUrl: string; redisUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  return async (): Promise<{ notified: number; storesEvaluated: number; resolved: number }> => {
    const reviewRequired = await findDocumentsReviewRequired(db);

    const byStore = new Map<string, { organizationId: string; storeId: string; documents: DocumentReviewRequiredRow[] }>();
    for (const row of reviewRequired) {
      const existing = byStore.get(row.storeId);
      if (existing) {
        existing.documents.push(row);
      } else {
        byStore.set(row.storeId, { organizationId: row.organizationId, storeId: row.storeId, documents: [row] });
      }
    }

    let notified = 0;
    const evaluatedDedupKeys = new Set<string>();

    for (const group of byStore.values()) {
      try {
        const dedupKey = buildDocumentReviewRequiredDedupKey(group.storeId);
        const created = await evaluateStoreGroup(db, config.redisUrl, group.organizationId, group.storeId, group.documents);
        if (created) notified += 1;
        evaluatedDedupKeys.add(dedupKey);
      } catch (error) {
        // One store's evaluation failing (a transient DB error) must not abort every other real
        // store already handled in this same tick.
        console.error(`Document review-required sweep: failed to evaluate store ${group.organizationId}/${group.storeId}`, error);
      }
    }

    const resolved = await resolveStaleNotifications(db, evaluatedDedupKeys);

    return { notified, storesEvaluated: byStore.size, resolved };
  };
};

const resolveStaleNotifications = async (db: ReturnType<typeof createDb>['db'], evaluatedDedupKeys: Set<string>): Promise<number> => {
  const openNotifications = await findOpenNotificationsByDedupPrefix(db, 'document_review_required');
  let resolved = 0;
  for (const notification of openNotifications) {
    if (evaluatedDedupKeys.has(notification.dedupKey)) continue;
    try {
      const notificationRepo = new NotificationRepository(db, notification.organizationId);
      await notificationRepo.markResolved(notification.id);
      resolved += 1;
    } catch (error) {
      console.error(`Document review-required sweep: failed to resolve stale notification ${notification.id} (org ${notification.organizationId})`, error);
    }
  }
  return resolved;
};

const evaluateStoreGroup = async (
  db: ReturnType<typeof createDb>['db'],
  redisUrl: string,
  organizationId: string,
  storeId: string,
  documents: DocumentReviewRequiredRow[]
): Promise<boolean> => {
  const ruleRepo = new NotificationRuleRepository(db, organizationId);
  const candidates = (await ruleRepo.findEnabledByType('document_review_required')) as CandidateRule[];
  const applicableRule = resolveApplicableRule(candidates, storeId);
  const severity: AlertSeverity =
    (applicableRule?.severity as AlertSeverity | undefined) ?? DEFAULT_SEVERITY_BY_RULE_TYPE.document_review_required;

  const evaluation = evaluateDocumentReviewRequired(documents.length, { storeId }, severity);

  const notificationRepo = new NotificationRepository(db, organizationId);
  const existing = await notificationRepo.findOpenByDedupKey(evaluation.dedupKey);
  const action = resolveDedupAction(evaluation.fires, existing);

  switch (action.kind) {
    case 'CREATE':
    case 'UPDATE': {
      const rule = applicableRule ?? (await ruleRepo.create({
        ruleType: 'document_review_required',
        severity: DEFAULT_SEVERITY_BY_RULE_TYPE.document_review_required,
        threshold: {},
        recipientRoles: ['MANAGER'],
        channels: ['EMAIL'],
      })) as { id: string };
      const recipientRoles = applicableRule?.recipientRoles ?? ['MANAGER'];
      const channels = applicableRule?.channels ?? ['EMAIL'];

      const content = aggregateNotificationContent(
        documents.map((doc) => ({
          label: `${doc.type} document`,
          dollarImpact: null,
          severity: evaluation.severity,
        })),
        formatDocumentReviewRequiredTitle,
        formatDocumentReviewRequiredBody
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
