import { asc, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';
import { salesTransactions } from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type PendingConsumptionRow = {
  organizationId: string;
  storeId: string;
  transactionId: string;
  consumptionAttempts: number;
};

/**
 * Finds every `sales_transactions` row whose inventory consumption never completed —
 * `PENDING` (consumption was never attempted, e.g. the sync process crashed or threw before
 * reaching it) or `FAILED` (attempted and threw). Deliberately cross-tenant by nature, same
 * reasoning as `findNegativeStock`/`findUnpublishedOutboxEvents` — a retry sweep is an internal
 * infrastructure job across every tenant, not a single organization's scoped request. `db` must be
 * an admin-equivalent connection.
 *
 * `limit` bounds one sweep tick's batch size, matching `findUnpublishedOutboxEvents`'s own
 * reasoning — a large accumulated backlog must not become one unbounded pass. Ordered oldest-first
 * so a genuinely stuck transaction isn't perpetually starved behind a stream of newer failures.
 */
export const findPendingConsumptionTransactions = async (db: Db, limit: number): Promise<PendingConsumptionRow[]> => {
  const rows = await db
    .select({
      organizationId: salesTransactions.organizationId,
      storeId: salesTransactions.storeId,
      transactionId: salesTransactions.id,
      consumptionAttempts: salesTransactions.consumptionAttempts,
    })
    .from(salesTransactions)
    .where(ne(salesTransactions.consumptionStatus, 'COMPLETED'))
    .orderBy(asc(salesTransactions.createdAt))
    .limit(limit);

  return rows;
};
