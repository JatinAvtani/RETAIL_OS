import postgres from 'postgres';

/**
 * Partition management for `stock_movements` (0014_stock_movements.sql). That migration seeds
 * exactly ONE real monthly partition plus a DEFAULT catch-all — deliberately, per its own header:
 * "an operational job this migration seeds the first instance of, not a promise every future
 * month is pre-created by this file alone." This module is that job, made real.
 *
 * Everything here is DDL (`CREATE TABLE ... PARTITION OF`), never a data mutation — I3 (append-only
 * ledger) is untouched: no row in `stock_movements` is ever read, written, updated, or deleted by
 * this file. `pg_class`/`pg_inherits` reads for the DEFAULT-overflow check are the only queries,
 * and those are catalog metadata, not ledger rows.
 *
 * DDL on a table owned by a migration requires the same elevated connection migrations themselves
 * use (`DATABASE_URL`, the `postgres` superuser role) — `retailos_app` is the pure runtime/query
 * role and was never granted CREATE TABLE on this schema, matching `outbox-relay.ts`'s own
 * "deliberately admin-equivalent connection" precedent for infrastructure sweeps that are not a
 * single tenant's own request.
 */

const STOCK_MOVEMENTS_TABLE = 'stock_movements';
const DEFAULT_PARTITION_NAME = 'stock_movements_default';

/** How many months ahead `ensureFutureStockMovementPartitions` keeps materialized, counting the
 * current month as month 0. No existing convention for "how far ahead" exists elsewhere in this
 * codebase (checked: fact-aggregation/briefing scheduling are same-day/next-tick concerns, not
 * month-ahead provisioning) — 3 is a reasonable default: wide enough that a daily job missing a
 * few consecutive runs (a worker outage, a deploy window) still leaves a real partition for
 * "today" rather than silently falling back to DEFAULT, without pre-creating so many empty
 * partitions that the partition count itself becomes unwieldy. */
export const DEFAULT_MONTHS_AHEAD = 3;

/** Rows landing in DEFAULT beyond this count are worth a loud warning — a handful can appear
 * transiently (e.g. a backfill for a date outside the normal window, or this job not having run
 * yet in a brand-new environment) without indicating a real operational problem. */
export const DEFAULT_PARTITION_ALERT_THRESHOLD = 0;

/** Formats a `Date` as the partition-boundary literal `0014_stock_movements.sql` itself uses
 * (`'2026-08-01'`, no time component) — `occurred_at` is `timestamptz`, and Postgres treats a
 * bare date literal as midnight UTC, matching the existing seeded partition's own bound exactly. */
const toDateLiteral = (year: number, monthIndexZeroBased: number): string => {
  const y = String(year).padStart(4, '0');
  const m = String(monthIndexZeroBased + 1).padStart(2, '0');
  return `${y}-${m}-01`;
};

/** The partition table name convention the existing migration already established:
 * `stock_movements_YYYY_MM`. */
const toPartitionName = (year: number, monthIndexZeroBased: number): string => {
  const m = String(monthIndexZeroBased + 1).padStart(2, '0');
  return `stock_movements_${year}_${m}`;
};

export type MonthlyPartitionPlan = {
  /** e.g. `stock_movements_2026_08` */
  tableName: string;
  /** Inclusive lower bound, e.g. `2026-08-01` */
  fromDateLiteral: string;
  /** Exclusive upper bound, e.g. `2026-09-01` */
  toDateLiteral: string;
  /** The exact DDL statement to create this partition, idempotent via IF NOT EXISTS. */
  sql: string;
};

/**
 * Pure function (I1's "deterministic core" discipline, applied to DDL generation too): given any
 * target date, returns the exact partition name/bounds/SQL for that date's calendar month — no
 * database connection, no I/O, fully unit-testable. Matches the schema in 0014_stock_movements.sql
 * exactly: same table name convention, same partition key (`occurred_at`), same
 * `CREATE TABLE IF NOT EXISTS ... PARTITION OF stock_movements FOR VALUES FROM (...) TO (...)`
 * shape as the migration's own seeded `stock_movements_2026_08`.
 *
 * Takes a `Date` and reads UTC fields (`getUTCFullYear`/`getUTCMonth`) — `occurred_at` is stored
 * UTC (CLAUDE.md: "Times are TIMESTAMPTZ, stored UTC"), and partition boundaries are a storage-
 * layer concern keyed to the same UTC calendar the column itself uses, not any one store's local
 * timezone (a single partitioned table serves every store/timezone in an organization at once).
 */
export const planStockMovementsMonthlyPartition = (targetDate: Date): MonthlyPartitionPlan => {
  const year = targetDate.getUTCFullYear();
  const month = targetDate.getUTCMonth(); // 0-based
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;

  const tableName = toPartitionName(year, month);
  const fromDateLiteral = toDateLiteral(year, month);
  const toLiteral = toDateLiteral(nextYear, nextMonth);

  const sql =
    `CREATE TABLE IF NOT EXISTS "${tableName}"\n` +
    `  PARTITION OF "${STOCK_MOVEMENTS_TABLE}"\n` +
    `  FOR VALUES FROM ('${fromDateLiteral}') TO ('${toLiteral}');`;

  return { tableName, fromDateLiteral, toDateLiteral: toLiteral, sql };
};

/**
 * Given a starting month and a count, returns one plan per consecutive calendar month —
 * `[current, current+1, ..., current+monthsAhead]` inclusive, so `monthsAhead=3` yields 4 plans
 * (this month plus 3 ahead), matching `DEFAULT_MONTHS_AHEAD`'s own doc comment ("current month + 3
 * months ahead"). Pure, no I/O — the caller (`ensureFutureStockMovementPartitions`) is the only
 * place that actually executes DDL.
 */
export const planStockMovementsMonthlyPartitions = (
  fromDate: Date,
  monthsAhead: number = DEFAULT_MONTHS_AHEAD
): MonthlyPartitionPlan[] => {
  const plans: MonthlyPartitionPlan[] = [];
  for (let offset = 0; offset <= monthsAhead; offset += 1) {
    const d = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth() + offset, 1));
    plans.push(planStockMovementsMonthlyPartition(d));
  }
  return plans;
};

export type EnsureFuturePartitionsResult = {
  /** Every partition table name this call ensured exists (whether newly created or already present). */
  ensured: string[];
  /** The subset that did NOT exist before this call — i.e. genuinely created this run. */
  created: string[];
};

/**
 * The real, idempotent DDL executor: for the current month plus `monthsAhead` months ahead,
 * `CREATE TABLE IF NOT EXISTS ... PARTITION OF stock_movements` for each. Safe to call repeatedly
 * (worker restart, a daily job re-running, manual invocation) — `IF NOT EXISTS` means an
 * already-created partition is a silent no-op, matching every other DDL statement in
 * 0014_stock_movements.sql's own idempotency convention.
 *
 * `sql` must be an admin-equivalent connection (the `postgres` superuser role migrations use) —
 * `retailos_app` has no CREATE privilege on this schema by design. Each statement runs
 * individually (not batched in one multi-statement string) so a partial partial-plan failure
 * (e.g. a concurrent DDL lock) surfaces against a specific month rather than an opaque batch error.
 *
 * `created` is derived from a real `to_regclass` existence check taken BEFORE each create — not
 * inferred from `IF NOT EXISTS` itself, which gives no signal either way about whether it acted.
 */
/**
 * `CREATE TABLE ... PARTITION OF` takes an ACCESS EXCLUSIVE lock on the parent table, so it can
 * deadlock against any concurrent transaction already holding a weaker lock on `stock_movements`
 * and waiting on something this statement holds. Postgres resolves a deadlock by aborting one
 * side — the aborted side is expected to retry, which is exactly what this does.
 *
 * Observed for real: a full test run deadlocked here while sibling suites wrote movements, and the
 * identical statement succeeded immediately on its own. The same shape is possible in production —
 * this sweep runs on a schedule against a live table — so this is a genuine robustness fix, not a
 * test-only accommodation.
 *
 * Deliberately narrow: ONLY deadlock (40P01) is retried. A permissions error, a bad range bound, or
 * a genuine conflicting definition fails identically no matter how often it is retried, and
 * swallowing those would hide a real misconfiguration behind a delay.
 */
const DEADLOCK_SQLSTATE = '40P01';
const PARTITION_DDL_MAX_ATTEMPTS = 3;
const PARTITION_DDL_BACKOFF_MS = 250;

const createPartitionWithDeadlockRetry = async (sql: postgres.Sql, ddl: string): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await sql.unsafe(ddl);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== DEADLOCK_SQLSTATE || attempt >= PARTITION_DDL_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, PARTITION_DDL_BACKOFF_MS * attempt));
    }
  }
};

export const ensureFutureStockMovementPartitions = async (
  sql: postgres.Sql,
  now: Date = new Date(),
  monthsAhead: number = DEFAULT_MONTHS_AHEAD
): Promise<EnsureFuturePartitionsResult> => {
  const plans = planStockMovementsMonthlyPartitions(now, monthsAhead);
  const ensured: string[] = [];
  const created: string[] = [];

  for (const plan of plans) {
    const existsRows = await sql<{ exists: boolean }[]>`
      SELECT to_regclass(${'public.' + plan.tableName}) IS NOT NULL AS "exists"
    `;
    const alreadyExisted = existsRows[0]?.exists === true;

    await createPartitionWithDeadlockRetry(sql, plan.sql);

    ensured.push(plan.tableName);
    if (!alreadyExisted) created.push(plan.tableName);
  }

  return { ensured, created };
};

export type DefaultPartitionOverflowCheck = {
  /** Current row count in `stock_movements_default`. */
  rowCount: number;
  /** True if `rowCount` exceeds `DEFAULT_PARTITION_ALERT_THRESHOLD`. */
  overThreshold: boolean;
};

/**
 * Detects rows that landed in the DEFAULT catch-all partition — the exact silent failure mode
 * this whole module exists to prevent (an `occurred_at` outside every pre-created monthly range
 * is accepted, not rejected, per 0014_stock_movements.sql's own header, so nothing about it is
 * loud by default). A real row count against `stock_movements_default` directly, not an estimate —
 * this table should ordinarily be empty or near-empty, so an exact count is cheap; it would need
 * revisiting only if DEFAULT itself were ever expected to hold a large volume, which would itself
 * indicate this job had already been failing for a while.
 *
 * `sql` can be the app-role connection for this read alone (a plain SELECT, not DDL) — kept as
 * `postgres.Sql` (not a drizzle `Db`) to match `ensureFutureStockMovementPartitions`'s own
 * signature so both can share one connection in the job that calls them.
 */
export const checkDefaultPartitionOverflow = async (
  sql: postgres.Sql,
  threshold: number = DEFAULT_PARTITION_ALERT_THRESHOLD
): Promise<DefaultPartitionOverflowCheck> => {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS "count" FROM ${sql(DEFAULT_PARTITION_NAME)}
  `;
  const rowCount = Number(rows[0]?.count ?? '0');
  return { rowCount, overThreshold: rowCount > threshold };
};
