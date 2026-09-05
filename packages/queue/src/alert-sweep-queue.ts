import { Queue } from 'bullmq';
import type Redis from 'ioredis';

/**
 * Two more real, time-based rule-evaluation triggers, alongside the outbox-relay's own
 * `outbox-relay-poll` — `lot_expiring` and `negative_stock` have no domain event to consume (see
 * `rule-evaluation-processor.ts`'s own header for why), so each gets a plain repeatable "tick"
 * queue exactly like `RELAY_POLL_QUEUE_NAME`'s own shape: no per-invocation `job.data`, since a
 * sweep always evaluates every active tenant's CURRENT state, not a specific entity a caller names.
 * Two separate queues, not one shared "alert sweep" queue — matching this codebase's own
 * established "split by resource profile" convention at the queue level (CLAUDE.md): the two
 * sweeps read from unrelated tables (`lots`+`stock_movements` vs. `stock_levels`) and could
 * legitimately need different tick intervals or concurrency in the future without one change
 * forcing a redeploy of the other's schedule.
 */
export const LOT_EXPIRY_SWEEP_QUEUE_NAME = 'lot-expiry-sweep';

export const createLotExpirySweepQueue = (connection: Redis): Queue => new Queue(LOT_EXPIRY_SWEEP_QUEUE_NAME, { connection });

/**
 * Every 30 minutes — frequent enough that a lot crossing into the configured expiry window is
 * surfaced same-day without needing store-local 06:00 precision (the briefing's own stricter
 * requirement doesn't apply here: nothing about "N days to expiry" changes meaning at a specific
 * local hour, unlike the briefing's explicit "wrong local time" risk), infrequent enough that
 * re-scanning `findExpiryQueue`'s real cross-tenant read on every tick stays cheap.
 */
export const registerLotExpirySweepJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('lot-expiry-sweep', { every: 30 * 60 * 1000 });
};

export const NEGATIVE_STOCK_SWEEP_QUEUE_NAME = 'negative-stock-sweep';

export const createNegativeStockSweepQueue = (connection: Redis): Queue => new Queue(NEGATIVE_STOCK_SWEEP_QUEUE_NAME, { connection });

/** Same 30-minute cadence as the lot-expiry sweep, for the same reason — negative stock is a real, already-happened data-integrity signal (a missed receipt), not something that needs sub-minute latency to be useful. */
export const registerNegativeStockSweepJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('negative-stock-sweep', { every: 30 * 60 * 1000 });
};

export const SALES_ANOMALY_SWEEP_QUEUE_NAME = 'sales-anomaly-sweep';

export const createSalesAnomalySweepQueue = (connection: Redis): Queue => new Queue(SALES_ANOMALY_SWEEP_QUEUE_NAME, { connection });

/**
 * A much slower cadence than the other two sweeps here — `sales_anomaly`'s own underlying signal
 * (a full calendar day's completed revenue against its seasonal-decomposition trend) genuinely
 * cannot change more than once per real trading day, matching `fact-aggregation-queue.ts`'s own
 * "the signal itself doesn't refresh faster than this" reasoning, not an arbitrary throttle. Every
 * 6 hours (not once daily) so a store that only crosses the 14-real-days-of-history threshold
 * partway through a day still gets evaluated same-day, without the cost of a 30-minute tick a
 * daily-resolution signal has no use for.
 */
export const registerSalesAnomalySweepJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('sales-anomaly-sweep', { every: 6 * 60 * 60 * 1000 });
};

export const UNMAPPED_POS_ITEMS_SWEEP_QUEUE_NAME = 'unmapped-pos-items-sweep';

export const createUnmappedPosItemsSweepQueue = (connection: Redis): Queue => new Queue(UNMAPPED_POS_ITEMS_SWEEP_QUEUE_NAME, { connection });

/** Same 30-minute cadence as the lot-expiry/negative-stock sweeps — an unmapped item is a real, already-happened data-integrity signal (a catalog sync brought in a new item nobody has reviewed yet), not something needing sub-minute latency. */
export const registerUnmappedPosItemsSweepJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('unmapped-pos-items-sweep', { every: 30 * 60 * 1000 });
};

export const DOCUMENT_REVIEW_REQUIRED_SWEEP_QUEUE_NAME = 'document-review-required-sweep';

export const createDocumentReviewRequiredSweepQueue = (connection: Redis): Queue => new Queue(DOCUMENT_REVIEW_REQUIRED_SWEEP_QUEUE_NAME, { connection });

/** Same 30-minute cadence as the lot-expiry/negative-stock/unmapped-items sweeps — a document stuck at REVIEW_REQUIRED is a real, already-happened data-integrity signal (extraction confidence didn't clear the auto-approval bar), not something needing sub-minute latency. */
export const registerDocumentReviewRequiredSweepJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('document-review-required-sweep', { every: 30 * 60 * 1000 });
};

export const INVESTIGATION_TRIGGER_QUEUE_NAME = 'investigation-trigger-sweep';

export const createInvestigationTriggerQueue = (connection: Redis): Queue => new Queue(INVESTIGATION_TRIGGER_QUEUE_NAME, { connection });

/**
 * a downstream consumer of the (separately built, already-live)
 * `sales-anomaly-sweep`'s own notifications — deliberately its OWN queue/tick, not a hook wired
 * directly into that sweep, per this file's own established "split by resource profile" convention
 * (an LLM call per notification is a fundamentally different cost/concurrency profile than a cheap
 * DB-only detection sweep). Every 15 minutes — frequent enough that a real anomaly detected by the
 * 6-hourly sales-anomaly sweep gets investigated same-tick-cycle rather than sitting uninvestigated
 * for hours, infrequent enough that `findUninvestigatedNotifications`'s cross-tenant scan (cheap —
 * it only ever returns a genuinely small, real backlog) stays a light tick between the actual
 * per-notification LLM calls it triggers.
 */
export const registerInvestigationTriggerJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('investigation-trigger-sweep', { every: 15 * 60 * 1000 });
};

export const SALES_CONSUMPTION_RETRY_SWEEP_QUEUE_NAME = 'sales-consumption-retry-sweep';

export const createSalesConsumptionRetrySweepQueue = (connection: Redis): Queue => new Queue(SALES_CONSUMPTION_RETRY_SWEEP_QUEUE_NAME, { connection });

/**
 * A shorter cadence than the other sweeps here — a stuck/failed consumption is a real, already-
 * recorded gap in inventory truth (a sale's ingredients were never deducted), which compounds every
 * minute it stays wrong (later stock-level reads, reorder suggestions, and margin metrics all read
 * a `stock_levels` projection that's silently missing this sale's draw). Every 5 minutes.
 */
export const registerSalesConsumptionRetrySweepJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('sales-consumption-retry-sweep', { every: 5 * 60 * 1000 });
};

export const MARGIN_DROP_SWEEP_QUEUE_NAME = 'margin-drop-sweep';

export const createMarginDropSweepQueue = (connection: Redis): Queue => new Queue(MARGIN_DROP_SWEEP_QUEUE_NAME, { connection });

/**
 * `margin_drop`'s own real trigger — matching `sales-anomaly-sweep`'s cadence exactly: the
 * underlying signal (a rolling 7-day-vs-7-day contribution-margin comparison) genuinely cannot
 * change more than once per completed trading day, so every 6 hours catches a fresh day's data
 * without the cost of a 30-minute tick a daily-resolution signal has no use for.
 */
export const registerMarginDropSweepJob = async (queue: Queue): Promise<void> => {
  await queue.upsertJobScheduler('margin-drop-sweep', { every: 6 * 60 * 60 * 1000 });
};
