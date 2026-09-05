import {
  createDb,
  findPendingConsumptionTransactions,
  SalesTransactionRepository,
} from '@retailos/db';
import { triggerConsumptionForTransaction } from '@retailos/integrations';

/** One sweep tick's batch size — bounds a single pass so a large accumulated backlog cannot become one unbounded run, matching `findUnpublishedOutboxEvents`'s own established sweep-sizing convention. */
const BATCH_SIZE = 200;

/**
 * `sale to consumption handoff`'s real repair tooling — the audit's own wording. Durable state
 * (`sales_transactions.consumption_status`) and the cross-tenant query
 * (`findPendingConsumptionTransactions`) were already built, but nothing ever called them: a
 * transaction whose consumption crashed mid-sync (`PENDING`, never attempted) or threw
 * (`FAILED`, attempted and failed) stayed stuck forever with no retry path, silently skipping real
 * inventory consumption for that sale.
 *
 * `triggerConsumptionForTransaction(..., checkRetry: true)` is what makes this actually safe to
 * re-run: `consumeFefo`'s idempotent-replay check means a transaction that already consumed SOME
 * of its ingredients (a partial failure) only consumes the ones still missing on retry, never
 * double-drawing stock for ingredients a prior attempt already posted (see
 * `movement-service.ts`'s own `checkIdempotent` doc comment for the full reasoning).
 *
 * Deliberately NOT event-driven — there is no "a transaction's consumption just failed" outbox
 * event (the failure is caught and recorded inline, not published), so a scheduled sweep is the
 * only mechanism, matching `lot-expiry-sweep-processor.ts`'s own reasoning for its rule type.
 */
export const createSalesConsumptionRetryProcessor = (config: { databaseUrl: string }) => {
  const { db } = createDb(config.databaseUrl);

  return async (): Promise<{ retried: number; recovered: number; stillFailing: number }> => {
    const pending = await findPendingConsumptionTransactions(db, BATCH_SIZE);

    let recovered = 0;
    let stillFailing = 0;

    for (const row of pending) {
      const salesTransactionRepository = new SalesTransactionRepository(db, row.organizationId);
      try {
        await triggerConsumptionForTransaction(db, row.organizationId, row.storeId, row.transactionId, true);
        await salesTransactionRepository.markConsumptionCompleted(row.transactionId);
        recovered += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await salesTransactionRepository.markConsumptionFailed(row.transactionId, message);
        stillFailing += 1;
        console.error(`Sales consumption retry: transaction ${row.transactionId} (org ${row.organizationId}) failed again (attempt ${row.consumptionAttempts + 1}): ${message}`);
      }
    }

    return { retried: pending.length, recovered, stillFailing };
  };
};
