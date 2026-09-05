// Loads .env.local so this script runs straight from a fresh clone (see load-env.ts).
import '@retailos/config/auto';
/**
 * The "queue health" gap an external audit flagged: BullMQ job counts, dead-letter depth, and
 * oldest-job age were tracked by BullMQ itself (`getJobCounts` is a real, built-in method) but
 * nothing in this codebase ever surfaced them anywhere. Deliberately a standalone script, not a
 * tRPC endpoint — queue health spans every organization's jobs at once, and this codebase has no
 * "platform operator" role distinct from a tenant's own OWNER; exposing it through the running app
 * would mean any tenant OWNER could see infrastructure-level activity belonging to every OTHER
 * tenant, which is itself a minor cross-tenant leak the router-based endpoints elsewhere in this
 * codebase are specifically designed to prevent (see `cross-tenant.test.ts`'s own merge gate).
 *
 * Usage: pnpm --filter @retailos/worker queue:health
 */
import { Queue } from 'bullmq';
import {
  createQueueRedisConnection,
  EXTRACTION_QUEUE_NAME,
  FACT_AGGREGATION_QUEUE_NAME,
  EMBEDDING_QUEUE_NAME,
  RELAY_QUEUE_NAME,
  RELAY_POLL_QUEUE_NAME,
  NOTIFICATION_DELIVERY_QUEUE_NAME,
  BRIEFING_QUEUE_NAME,
  BRIEFING_SCHEDULE_POLL_QUEUE_NAME,
  SQUARE_SYNC_QUEUE_NAME,
  STOCK_MOVEMENTS_PARTITION_QUEUE_NAME,
  LOT_EXPIRY_SWEEP_QUEUE_NAME,
  NEGATIVE_STOCK_SWEEP_QUEUE_NAME,
  SALES_ANOMALY_SWEEP_QUEUE_NAME,
  UNMAPPED_POS_ITEMS_SWEEP_QUEUE_NAME,
  DOCUMENT_REVIEW_REQUIRED_SWEEP_QUEUE_NAME,
  SALES_CONSUMPTION_RETRY_SWEEP_QUEUE_NAME,
} from '@retailos/queue';

const QUEUE_NAMES = [
  EXTRACTION_QUEUE_NAME,
  FACT_AGGREGATION_QUEUE_NAME,
  EMBEDDING_QUEUE_NAME,
  RELAY_QUEUE_NAME,
  RELAY_POLL_QUEUE_NAME,
  NOTIFICATION_DELIVERY_QUEUE_NAME,
  BRIEFING_QUEUE_NAME,
  BRIEFING_SCHEDULE_POLL_QUEUE_NAME,
  SQUARE_SYNC_QUEUE_NAME,
  STOCK_MOVEMENTS_PARTITION_QUEUE_NAME,
  LOT_EXPIRY_SWEEP_QUEUE_NAME,
  NEGATIVE_STOCK_SWEEP_QUEUE_NAME,
  SALES_ANOMALY_SWEEP_QUEUE_NAME,
  UNMAPPED_POS_ITEMS_SWEEP_QUEUE_NAME,
  DOCUMENT_REVIEW_REQUIRED_SWEEP_QUEUE_NAME,
  SALES_CONSUMPTION_RETRY_SWEEP_QUEUE_NAME,
];

/** A stuck/oldest job past this age is flagged — the same "something is genuinely wrong, not just busy" signal a real on-call alert would page on. 30 minutes covers this codebase's own slowest normal-path job (the 15-minute briefing schedule poll) with headroom, without being so long a real stall goes unnoticed for hours. */
const STALE_JOB_THRESHOLD_MS = 30 * 60 * 1000;

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error('REDIS_URL is required.');
  process.exit(1);
}

const connection = createQueueRedisConnection(redisUrl);

type QueueHealthRow = {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  oldestWaitingAgeMs: number | null;
};

const inspectQueue = async (name: string): Promise<QueueHealthRow> => {
  const queue = new Queue(name, { connection });
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    const [oldestWaiting] = await queue.getJobs(['waiting'], 0, 0, true);
    const oldestWaitingAgeMs = oldestWaiting ? Date.now() - oldestWaiting.timestamp : null;
    return {
      name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
      oldestWaitingAgeMs,
    };
  } finally {
    await queue.close();
  }
};

const rows = await Promise.all(QUEUE_NAMES.map(inspectQueue));

const nameWidth = Math.max(...rows.map((r) => r.name.length), 'QUEUE'.length);
console.log(
  `${'QUEUE'.padEnd(nameWidth)}  ${'WAITING'.padStart(7)}  ${'ACTIVE'.padStart(6)}  ${'DELAYED'.padStart(7)}  ${'FAILED'.padStart(6)}  ${'COMPLETED'.padStart(9)}  OLDEST WAITING`
);
let anyStale = false;
let anyFailed = false;
for (const row of rows) {
  const oldestLabel = row.oldestWaitingAgeMs === null ? '—' : `${Math.round(row.oldestWaitingAgeMs / 1000)}s`;
  const isStale = row.oldestWaitingAgeMs !== null && row.oldestWaitingAgeMs > STALE_JOB_THRESHOLD_MS;
  if (isStale) anyStale = true;
  if (row.failed > 0) anyFailed = true;
  const flag = isStale ? ' ⚠ STALE' : row.failed > 0 ? ' ⚠ FAILED>0' : '';
  console.log(
    `${row.name.padEnd(nameWidth)}  ${String(row.waiting).padStart(7)}  ${String(row.active).padStart(6)}  ${String(row.delayed).padStart(7)}  ${String(row.failed).padStart(6)}  ${String(row.completed).padStart(9)}  ${oldestLabel}${flag}`
  );
}

console.log('');
if (anyStale || anyFailed) {
  console.log(`Exit 1: ${anyStale ? 'a queue has a waiting job older than the stale threshold' : ''}${anyStale && anyFailed ? '; ' : ''}${anyFailed ? 'a queue has real failed jobs' : ''}.`);
}

await connection.quit();
process.exit(anyStale || anyFailed ? 1 : 0);
