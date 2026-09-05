import postgres from 'postgres';
import {
  checkDefaultPartitionOverflow,
  ensureFutureStockMovementPartitions,
  DEFAULT_PARTITION_ALERT_THRESHOLD,
} from '@retailos/db';

/**
 * The real worker-side handler for the daily stock-movements-partition-maintenance job — a thin
 * adapter over `ensureFutureStockMovementPartitions`/`checkDefaultPartitionOverflow`
 * (`packages/db`), matching `createFactAggregationProcessor`'s own "processor is a thin adapter,
 * the real logic lives in a plain function" shape.
 *
 * Connects with `config.adminDatabaseUrl` (the same `postgres` superuser role `db:migrate` uses),
 * NOT the `retailos_app` role every other processor in this directory uses — `CREATE TABLE ...
 * PARTITION OF` is DDL, and `retailos_app` was never granted CREATE on this schema by design
 * (matching `outbox-relay.ts`'s own admin-connection precedent for infrastructure sweeps that
 * aren't a single tenant's request). A fresh `postgres()` client is opened per job run and closed
 * at the end — this job runs once a day, not on a hot path, so a pooled long-lived connection
 * (like `createDb`'s) isn't worth the privilege footprint of holding an admin connection open for
 * the worker process's entire lifetime.
 *
 * Overflow detection is a logged warning, not a full `notification_rules` integration — the
 * DEFAULT partition receiving rows is a storage/ops signal about this job itself (or a clock/data
 * anomaly), not a per-tenant business exception the rule-engine's dedup/severity/recipient model
 * was built for (see `packages/domain/src/notifications/rule-engine.ts`: every existing rule type
 * is keyed to one tenant's own domain event). A loud `console.error` on every run this happens
 * matches this file's own established convention (`relay-poll-processor.ts`,
 * `briefing-schedule-poll-processor.ts`) and is genuinely visible in whatever collects this
 * process's stderr — escalating further is straightforward once this surfaces as a real signal
 * worth acting on, per the task's own "don't over-engineer" scope.
 */
export const createStockMovementsPartitionProcessor = (config: { adminDatabaseUrl: string }) => {
  return async (): Promise<{ ensured: string[]; created: string[]; defaultPartitionRowCount: number }> => {
    const sql = postgres(config.adminDatabaseUrl);
    try {
      const { ensured, created } = await ensureFutureStockMovementPartitions(sql);

      if (created.length > 0) {
        console.log(`Stock movements partition maintenance: created ${created.length} new partition(s): ${created.join(', ')}`);
      }

      const overflow = await checkDefaultPartitionOverflow(sql, DEFAULT_PARTITION_ALERT_THRESHOLD);
      if (overflow.overThreshold) {
        console.error(
          `Stock movements partition maintenance: ${overflow.rowCount} row(s) found in the DEFAULT catch-all partition ` +
            `(stock_movements_default) — this means at least one stock_movements row's occurred_at falls outside every ` +
            `pre-created monthly partition. Investigate: either a row's occurred_at is unexpectedly far in the past/future, ` +
            `or this job has not run recently enough to keep ahead of real writes.`
        );
      }

      return { ensured, created, defaultPartitionRowCount: overflow.rowCount };
    } finally {
      await sql.end();
    }
  };
};
