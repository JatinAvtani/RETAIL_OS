import type { Job } from 'bullmq';
import {
  NotificationRepository,
  NotificationRuleRepository,
  StoreRepository,
  createDb,
} from '@retailos/db';
import {
  buildDailyBriefingDedupKey,
  DEFAULT_SEVERITY_BY_RULE_TYPE,
  resolveApplicableRule,
  resolveDedupAction,
  resolveLocalDate,
  type CandidateRule,
} from '@retailos/domain';
import { createGeminiChatProvider, modelForTask } from '@retailos/ai';
import { ALL_PERMISSIONS, type AuthContext } from '@retailos/authz';
import type { MetricContext, MetricResult } from '@retailos/metrics';
import { executeMetric, MetricPermissionDeniedError } from '@retailos/metrics';
import { rankExceptions, toBriefingBundle, narrateAndValidate, type BriefingCandidate } from '@retailos/assistant';
import type { BriefingJobData } from '@retailos/queue';
import { notifyRecipients } from './notification-fanout';

/**
 * "06:00 store-local → compute the exception set via metric calls → rank by estimated
 * dollar impact → top 3–6 → LLM writes ONLY connective prose → grounding validator applies (I1) →
 * deliver: email + push." The exception-computation and ranking are NOT new logic — `rankExceptions`/
 * `toBriefingBundle`/the exact metric spec list are the SAME real code the `assistant.briefing`
 * query already built and this deliberately reuses (I2: not a second, independently drifting
 * definition of "what counts as an exception"). What's genuinely new here: this runs on a SCHEDULE
 * (not a user opening a page) and DELIVERS through the real notification pipeline
 * instead of returning an HTTP response — confirmed with the user: the briefing becomes one real
 * `notifications` row (severity INFO, matching the alert catalogue: "Daily briefing |
 * INFO | Owner, Manager"), reusing the EXACT SAME fan-out/email/quiet-hours-preference machinery
 * every other alert type already gets, rather than a separate bespoke delivery path.
 *
 * Executes metrics under a synthetic OWNER-equivalent `AuthContext` (`ALL_PERMISSIONS`,
 * `storeIds: 'ALL'`) — there is no real logged-in caller when a scheduled job fires; the briefing is
 * an org-level digest, and WHO actually receives it is resolved separately by the rule's own
 * `recipientRoles` (defaulting to `['OWNER', 'MANAGER']`, matching the catalogue) at fan-out time,
 * not by narrowing what the job itself can read.
 */
export const createBriefingProcessor = (config: { databaseUrl: string; redisUrl: string; geminiApiKey: string | undefined }) => {
  const { db } = createDb(config.databaseUrl);

  return async (job: Job<BriefingJobData>): Promise<void> => {
    const { organizationId, storeId } = job.data;

    const storeRepo = new StoreRepository(db, organizationId);
    const store = await storeRepo.findById(storeId);
    if (!store) {
      // The store was deleted/closed after this job was scheduled — the next schedule-poll tick
      // will stop re-registering it; nothing to brief right now.
      return;
    }

    const auth: AuthContext = {
      userId: 'system-daily-briefing',
      organizationId,
      storeIds: 'ALL',
      role: 'OWNER',
      permissions: new Set(ALL_PERMISSIONS),
    };
    const metricCtx: MetricContext = { db, organizationId, storeIds: 'ALL' };

    const tryMetric = async (fn: () => Promise<MetricResult>): Promise<MetricResult | null> => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof MetricPermissionDeniedError) return null;
        throw error;
      }
    };

    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000); // matches assistant.briefing's own BRIEFING_WINDOW_DAYS
    const windowParams = { storeId, from, to };

    // The SAME exception spec list assistant.briefing already defines — deliberately duplicated
    // here rather than imported, since it lives inside apps/api's router file (not a shared
    // package export) and this worker cannot import from apps/api (module-boundary direction: apps
    // depend on packages, never on each other). If this list needs to change, change it in BOTH
    // places — flagged here rather than silently risking drift.
    const specs: { id: string; severity: 'danger' | 'warning'; label: string; run: () => Promise<MetricResult> }[] = [
      { id: 'expiry_risk_value', severity: 'warning', label: 'Stock is approaching its expiry date', run: () => executeMetric('expiry_risk_value', { storeId, horizonDays: 7 }, auth, metricCtx) },
      { id: 'dead_stock_value', severity: 'warning', label: 'Stock is sitting unsold', run: () => executeMetric('dead_stock_value', { storeId }, auth, metricCtx) },
      { id: 'negative_stock_incidents', severity: 'danger', label: 'Products are showing negative stock', run: () => executeMetric('negative_stock_incidents', { storeId }, auth, metricCtx) },
      { id: 'stock_projection_drift', severity: 'danger', label: 'Stock records disagree with the ledger — a data-integrity problem', run: () => executeMetric('stock_projection_drift', {}, auth, metricCtx) },
      { id: 'documents_pending_review', severity: 'warning', label: 'Documents are awaiting review', run: () => executeMetric('documents_pending_review', { storeId }, auth, metricCtx) },
      { id: 'unmapped_pos_items_count', severity: 'warning', label: 'POS items are still unmapped, so consumption data is incomplete', run: () => executeMetric('unmapped_pos_items_count', { storeId }, auth, metricCtx) },
      { id: 'waste_spike', severity: 'warning', label: 'Waste was unusually high on some days', run: () => executeMetric('waste_spike', windowParams, auth, metricCtx) },
      { id: 'sales_anomaly', severity: 'warning', label: 'Sales activity was unusual on some days', run: () => executeMetric('sales_anomaly', windowParams, auth, metricCtx) },
    ];

    const settled = await Promise.all(specs.map(async (spec) => ({ spec, result: await tryMetric(spec.run) })));
    const candidates: BriefingCandidate[] = settled
      .filter((s): s is { spec: (typeof specs)[number]; result: MetricResult } => s.result !== null)
      .map(({ spec, result }) => ({ id: spec.id, severity: spec.severity, label: spec.label, result }));

    const ranked = rankExceptions(candidates);
    const localDate = resolveLocalDate(to, store.timezone);
    const dedupKey = buildDailyBriefingDedupKey(storeId, localDate);

    const notificationRepo = new NotificationRepository(db, organizationId);
    const existing = await notificationRepo.findOpenByDedupKey(dedupKey);
    const action = resolveDedupAction(ranked.length > 0, existing);

    if (action.kind === 'RESOLVE' || action.kind === 'NO_OP') {
      // A genuinely calm day: no real exceptions, and nothing was already open for today either.
      // The plan's own explicit anti-pattern: "a manufactured 'everything looks fine' briefing
      // trains users to ignore it" — so a calm day produces NO notification at all, not an
      // artificially cheerful one. If something WAS open (a prior retry this same day found
      // exceptions, a later retry finds none), it resolves rather than staying open forever.
      if (action.kind === 'RESOLVE') await notificationRepo.markResolved(action.existingId);
      return;
    }

    const bundle = toBriefingBundle(ranked);

    const title = 'Daily briefing';
    let body = ranked.map((r) => r.label).join('; '); // an honest fallback body if narration is unavailable
    if (config.geminiApiKey) {
      const provider = createGeminiChatProvider(config.geminiApiKey);
      const narrated = await narrateAndValidate(provider, bundle, [], [], [], modelForTask('NARRATE'));
      if (narrated.grounded && narrated.text) {
        // The target output's own headline convention ("Good morning. N things need attention.")
        // — the narrated prose IS the body; the first sentence typically already reads as a
        // headline, so title stays a stable, generic "Daily briefing" (matching the catalogue's
        // own literal alert name) rather than trying to extract a headline from free-form prose.
        body = narrated.text;
      }
    }

    const topMonetaryImpact = ranked.find((r) => r.monetaryImpact !== null)?.monetaryImpact ?? null;

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const candidatesForRule = (await ruleRepo.findEnabledByType('daily_briefing')) as CandidateRule[];
    const applicableRule = resolveApplicableRule(candidatesForRule, storeId);
    // Same auto-provisioning precedent as the stock_below_reorder path: a tenant with zero
    // configuration for this rule type still gets the catalogue default, never silently skipped.
    const rule = applicableRule ?? (await ruleRepo.create({
      ruleType: 'daily_briefing',
      severity: DEFAULT_SEVERITY_BY_RULE_TYPE.daily_briefing,
      threshold: {},
      recipientRoles: ['OWNER', 'MANAGER'],
      channels: ['EMAIL'],
    })) as { id: string };
    const recipientRoles = applicableRule?.recipientRoles ?? ['OWNER', 'MANAGER'];
    const channels = applicableRule?.channels ?? ['EMAIL'];

    const { id: notificationId } = await notificationRepo.upsertByDedupKey({
      storeId,
      ruleId: rule.id,
      severity: DEFAULT_SEVERITY_BY_RULE_TYPE.daily_briefing,
      title,
      body,
      dedupKey,
      ...(topMonetaryImpact !== null ? { dollarImpact: topMonetaryImpact } : {}),
    });

    // Fan-out only on a genuinely NEW notification, matching the delivery pipeline's own established rule — a
    // same-day retry that resolves to the SAME dedup key (UPDATE, not CREATE) must not re-deliver.
    if (action.kind === 'CREATE') {
      await notifyRecipients(db, config.redisUrl, organizationId, notificationId, storeId, DEFAULT_SEVERITY_BY_RULE_TYPE.daily_briefing, recipientRoles, channels);
    }
  };
};
