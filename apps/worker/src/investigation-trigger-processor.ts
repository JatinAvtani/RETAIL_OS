import {
  createDb,
  findUninvestigatedNotifications,
  InvestigationRepository,
  ProductRepository,
  SearchRepository,
  StoreRepository,
  SupplierProductRepository,
  type UninvestigatedNotification,
} from '@retailos/db';
import { runInvestigation } from '@retailos/assistant';
import { createGeminiChatProvider, modelForTask } from '@retailos/ai';
import { ALL_PERMISSIONS, type AuthContext } from '@retailos/authz';

/**
 * the real proactive trigger — confirmed via `AskUserQuestion` to run the full
 * investigation automatically the moment a real anomaly is detected, not lazily on first open. This
 * is a downstream CONSUMER of the already-built, already-tested `sales-anomaly-sweep-processor.ts`
 * (another session's real, finished work) — it never modifies that file, only reacts to what it
 * (and any future proactive evaluator, e.g. a `supplier_price_increase` one) already creates.
 *
 * Deliberately its OWN scheduled sweep (matching `lot-expiry-sweep-processor.ts`'s established
 * shape), not a hook wired directly into the anomaly sweep — decoupling avoids a real concurrent-
 * edit conflict on that file, and matches this codebase's own "split by resource profile" queue
 * convention: this consumer's real cost profile (an LLM call per notification) is entirely
 * different from a sweep's own cheap DB-only detection query, and could legitimately need a
 * different concurrency/interval in the future without forcing a redeploy of the other.
 *
 * `findUninvestigatedNotifications` (`packages/db`) is this processor's own real idempotency check
 * — a notification with an existing `investigations` row (RUNNING or terminal) is never re-queried
 * by that function at all, so this processor cannot double-investigate even under a retried/
 * overlapping tick (the unique index on `investigations(organization_id, source_notification_id)`
 * is the same guarantee's second, DB-enforced layer).
 */
/**
 * Which detected findings are worth an investigation's real cost (one LLM call each).
 *
 * Every entry is a margin/cash event whose ROOT CAUSE is a real question the multi-hop pipeline can
 * chase through the metric catalog — "why is this happening", not merely "this happened".
 * `lot_expiring` and `stock_below_reorder` earn their place on exactly that test: stock expiring
 * unsold, and a product repeatedly hitting its reorder point, are both demand/ordering questions
 * (over-ordering, a demand shift, a broken par level), not self-answering alerts.
 *
 * This list is deliberately SHORT, and measured rather than guessed. It was briefly widened to ten
 * rule types on the theory that more inputs meant more findings; over a full corpus, only these four
 * ever produced an investigation with a real, non-empty trace. The other six either never fire in
 * practice or resolve to a question the catalog cannot answer, so including them bought nothing and
 * cost real breadth: every extra type means sweeps touching more organizations, which is a wider
 * blast radius for no measured benefit.
 *
 * `daily_briefing` and `po_awaiting_approval` are excluded on principle rather than measurement — a
 * digest and a workflow prompt respectively, neither of which has a cause to find.
 *
 * Note for anyone tempted to add one back: `sales_anomaly` was once the ONLY entry here, and it is a
 * rule type this project's corpus never actually produces — so the findings feed was structurally
 * guaranteed to stay empty while the sweep ran "successfully" on every tick. Verify a candidate
 * genuinely fires and genuinely traces before adding it.
 */
export const RULE_TYPES_TO_INVESTIGATE = [
  'invoice_variance',
  'stock_below_reorder',
  'supplier_price_increase',
  'lot_expiring',
] as const;

/** Synthetic system context, matching `sales-anomaly-sweep-processor.ts`'s own established
 * precedent exactly — there is no real logged-in caller when a scheduled job fires. */
const buildSystemAuthContext = (organizationId: string): AuthContext => ({
  userId: 'system-investigation-trigger',
  organizationId,
  storeIds: 'ALL',
  role: 'OWNER',
  permissions: new Set(ALL_PERMISSIONS),
});

/**
 * One notification's own investigation, wrapped so a single failure (a provider timeout, an
 * unexpected pipeline error) never aborts every other real notification already queued this tick —
 * matching every other sweep processor's own per-item try/catch precedent in this codebase.
 */
const investigateOne = async (
  db: ReturnType<typeof createDb>['db'],
  geminiApiKey: string | undefined,
  notification: UninvestigatedNotification
): Promise<'investigated' | 'skipped' | 'failed'> => {
  const investigationRepo = new InvestigationRepository(db, notification.organizationId);

  // A concurrent tick, or a retry racing this same notification, is caught here BEFORE any model
  // call — cheaper than relying solely on the unique-index failure below, and avoids a wasted real
  // LLM call on a notification another worker process already claimed. Checked BEFORE the API-key
  // gate below so this real idempotency guarantee is exercisable (and tested) without a live key —
  // only the actual model call needs one, not the orchestration around it.
  const alreadyExists = await investigationRepo.findBySourceNotificationId(notification.id);
  if (alreadyExists !== null) return 'skipped';

  /**
   * The finding's own title/body IS the seed question — a real, honest re-framing of what was
   * detected, never a fabricated question the model wasn't actually asked.
   *
   * The finding is quoted as CONTEXT and the analytical question asked separately, rather than
   * concatenating the alert text and tacking "why did this happen" on the end. That earlier shape
   * failed in a specific, reproducible way: many alert bodies end in an imperative ("Raise a
   * purchase order before it runs out"), so the combined string read as a request to DO something.
   * `classifyIntent` is deliberately biased toward UNSUPPORTED whenever a question is ambiguous
   * between categories (a wrong route is worse than an honest refusal), so every such investigation
   * terminated at hop 1 with an empty trace — the pipeline working exactly as designed, on a
   * badly-posed question. Naming the task as root-cause analysis over a quoted finding removes the
   * ambiguity without putting words in the model's mouth.
   */
  const question =
    `Finding: "${notification.title}. ${notification.body}" ` +
    `What underlying change in the business explains this, based on the recorded numbers?`;

  const { id: investigationId } = await investigationRepo.createRunning({
    ...(notification.storeId !== null ? { storeId: notification.storeId } : {}),
    sourceNotificationId: notification.id,
    question,
  });

  // No key configured (CI, a fresh clone) — a real, honest FAILED row naming why, matching
  // `briefing-processor.ts`'s own established "degrade gracefully, never throw, never fabricate a
  // result" precedent for a missing provider key. The row still exists (never silently skipped),
  // so a real deploy WITHOUT a key produces a visible, diagnosable backlog rather than silence.
  if (geminiApiKey === undefined) {
    await investigationRepo.fail(investigationId, 'No Gemini API key configured on this worker.');
    return 'failed';
  }

  try {
    const provider = createGeminiChatProvider(geminiApiKey);
    const auth = buildSystemAuthContext(notification.organizationId);
    /**
     * `searchRepository` is REQUIRED for a `HYBRID`/`RETRIEVAL`-classified question to produce
     * anything — `runPipeline` returns an immediate `unsupported` outcome without it, before any
     * metric hop runs.
     *
     * Its absence here was silent and total: real findings classify as HYBRID with high confidence
     * ("what explains this, based on the recorded numbers" wants both metrics AND documents), so
     * EVERY proactive investigation completed with `hop_count: 0` and an empty trace, and the UI
     * honestly reported "no groundable answer was found". Nothing errored; the pipeline was
     * refusing a question it had no way to answer. `assistant.ts` and `finance-controller.ts` both
     * already construct their context this way — only this worker path was missing it.
     */
    const metricCtx = {
      db,
      organizationId: notification.organizationId,
      storeIds: 'ALL' as const,
      geminiApiKey,
      searchRepository: new SearchRepository(db, notification.organizationId),
    };

    const accessibleStores = (await new StoreRepository(db, notification.organizationId).findAll()).map((store) => ({
      id: store.id,
      name: store.name,
    }));
    const accessibleProducts = await new ProductRepository(db, notification.organizationId).findAllWithDefaultVariant();
    const actionCandidates = await new SupplierProductRepository(db, notification.organizationId).findAllConfirmedWithLabels();

    const outcome = await runInvestigation(
      question,
      provider,
      modelForTask('CLASSIFY'),
      modelForTask('PLAN'),
      modelForTask('NARRATE'),
      auth,
      metricCtx,
      accessibleStores,
      accessibleProducts,
      actionCandidates
    );

    if (outcome.kind === 'investigation') {
      await investigationRepo.complete(investigationId, { hopCount: outcome.steps.length, trace: outcome.steps, draft: null });
      return 'investigated';
    }
    if (outcome.kind === 'draft') {
      await investigationRepo.complete(investigationId, { hopCount: outcome.steps.length, trace: outcome.steps, draft: outcome.draft });
      return 'investigated';
    }
    // 'unsupported' — a real, honest outcome (e.g. the seed question resolved to an intent this
    // pipeline can't answer at all) — recorded as a completed investigation with an empty trace,
    // never silently discarded, so the finding still shows SOMETHING when a human opens it.
    //
    // Logged rather than counted silently: an empty-trace "success" is indistinguishable from a
    // real one in the tick's own summary, which is exactly how a total pipeline outage (every
    // HYBRID question refused for a missing `searchRepository`) once looked like 30 healthy
    // investigations. The reason is the only thing that tells the two apart.
    console.warn(
      `Investigation trigger: notification ${notification.id} produced no trace — ${outcome.kind}: ${outcome.reason}`
    );
    await investigationRepo.complete(investigationId, { hopCount: 0, trace: [], draft: null });
    return 'investigated';
  } catch (error) {
    await investigationRepo.fail(investigationId, error instanceof Error ? error.message : String(error));
    return 'failed';
  }
};

/**
 * How many findings one tick will investigate, and how long it waits between them.
 *
 * A single investigation is not one model call — it is a classify + plan + narrate per hop, up to
 * the hop limit, so roughly 4-6 calls. The provider's free tier allows 15 requests per MINUTE, so
 * an unpaced loop over a real backlog exhausts the quota within the first two or three findings
 * and every remaining one fails with a 429. That is precisely what happened on a real backlog of
 * 54: two produced genuine 3-hop traces and the rest came back empty, which looked like a model
 * quality problem and was actually a pacing one.
 *
 * The 429 is deliberately NOT retried (see `gemini-chat-provider.ts`) — retrying a spent quota
 * only deepens it. Pacing is the real fix; the batch cap bounds one tick's total spend so a large
 * backlog drains over several ticks instead of burning the day's quota in one.
 */
const MAX_INVESTIGATIONS_PER_TICK = 3;
/**
 * Read per-tick, not once at module load, so a test can exercise the real pacing code path without
 * paying real wall-clock time — the delay exists to protect a live provider's per-minute quota, and
 * there is no live provider in a test. (Module-load evaluation would be defeated by ES import
 * hoisting: the module initialises before any assignment in the importing test file runs.)
 */
const delayBetweenInvestigationsMs = (): number => Number(process.env.INVESTIGATION_TRIGGER_DELAY_MS ?? 20_000);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const createInvestigationTriggerProcessor = (config: { databaseUrl: string; geminiApiKey: string | undefined }) => {
  const { db } = createDb(config.databaseUrl);

  return async (): Promise<{ investigated: number; skipped: number; failed: number }> => {
    const notifications = await findUninvestigatedNotifications(db, RULE_TYPES_TO_INVESTIGATE);
    const batch = notifications.slice(0, MAX_INVESTIGATIONS_PER_TICK);

    let investigated = 0;
    let skipped = 0;
    let failed = 0;

    for (const [index, notification] of batch.entries()) {
      // Spaced, not fired in a tight loop — see MAX_INVESTIGATIONS_PER_TICK. No delay before the
      // first, and none after the last, so a single-item tick stays immediate.
      if (index > 0) await sleep(delayBetweenInvestigationsMs());
      try {
        const result = await investigateOne(db, config.geminiApiKey, notification);
        if (result === 'investigated') investigated += 1;
        else if (result === 'skipped') skipped += 1;
        else failed += 1;
      } catch (error) {
        // A failure BEFORE `investigateOne`'s own try/catch (e.g. the createRunning insert itself)
        // must not abort every other real notification already queued this tick.
        console.error(`Investigation trigger: failed to process notification ${notification.id} (org ${notification.organizationId})`, error);
        failed += 1;
      }
    }

    return { investigated, skipped, failed };
  };
};
