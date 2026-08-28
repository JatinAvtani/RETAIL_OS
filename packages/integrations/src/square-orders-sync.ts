import { and, eq } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import {
  createDb,
  PosConnectionRepository,
  SalesIngestionPipeline,
  MovementService,
  posConnections,
  posItems,
  salesTransactionLines,
  salesTransactions,
  outboxEvents,
  withTenantContext,
  type PosConnectionStatus,
  type Tx,
} from '@retailos/db';
import { decryptToken, encryptToken, fetchSquareOrders, refreshSquareToken, type SquareOAuthConfig, type ExternalTransaction } from '@retailos/pos';
import { generateId, type CurrencyCode } from '@retailos/domain';
import { SquareNotConnectedError } from './square-catalog-sync';

export { SquareNotConnectedError };

type Db = ReturnType<typeof createDb>['db'];

export class SquareLocationMissingError extends Error {
  constructor() {
    super('This store’s Square connection has no linked location — reconnect Square.');
    this.name = 'SquareLocationMissingError';
  }
}

export type SquareOrdersSyncResult = {
  ordersSeen: number;
  transactionsRecorded: number;
  transactionsDuplicate: number;
  refundsProcessed: number;
};

export type SquareReconciliationResult = SquareOrdersSyncResult;

/**
 * "orders sync, cursor-based incremental." Mirrors `square-catalog-sync.ts`'s
 * connection-lookup + proactive-token-refresh shape, then diverges for the part the plan calls out as
 * this task's central risk: **the cursor MUST advance in the SAME transaction as the order/line
 * writes it gates** — "advancing before a failed write silently skips data forever, and nothing
 * errors." Each fetched page is written inside exactly ONE `db.transaction`: every order's header +
 * lines insert with `.onConflictDoNothing()` (idempotent on `(organization_id, source, external_id)`,
 * proven at the schema layer by earlier work), the connection's `ordersSyncCursor` advances, and a
 * `sales.ingested` outbox event is inserted — all three or none, per commit (I8).
 *
 * after each page's recording transaction COMMITS, this function triggers real
 * consumption (`SalesIngestionPipeline.ingestSaleLine`) for every newly-recorded `COMPLETED`
 * transaction's lines, and detects/reverses refunds on orders that already existed from a prior
 * sync. Both steps run OUTSIDE the recording transaction deliberately —
 * `SalesIngestionPipeline`/`SaleConsumptionService`/`MovementService.consumeFefo` each open their
 * own transaction internally, and composing an already-transacted call into this function's own
 * transaction would silently produce two commits, not one (the same lesson that already forced
 * `recordOrderInTx` to write raw tables instead of reusing `SalesTransactionRepository`). A
 * consumption or reversal failure for one line does not fail the whole sync — each is caught and
 * counted, matching `SaleConsumptionService`'s own per-ingredient failure isolation.
 */
export const syncSquareOrders = async (
  db: Db,
  organizationId: string,
  storeId: string,
  config: SquareOAuthConfig,
  encryptionKey: string | undefined
): Promise<SquareOrdersSyncResult> => {
  const connectionRepository = new PosConnectionRepository(db, organizationId);
  const connection = await connectionRepository.findByStoreAndVendor(storeId, 'square');
  if (!connection) {
    throw new SquareNotConnectedError();
  }
  if (!connection.externalLocationId) {
    throw new SquareLocationMissingError();
  }

  let accessToken = decryptToken(connection.accessTokenCiphertext, encryptionKey);

  const tokenExpired = connection.tokenExpiresAt !== null && connection.tokenExpiresAt <= new Date();
  if (tokenExpired && connection.refreshTokenCiphertext) {
    try {
      const refreshed = await refreshSquareToken(config, decryptToken(connection.refreshTokenCiphertext, encryptionKey));
      accessToken = refreshed.accessToken;
      await connectionRepository.upsert({
        id: connection.id,
        storeId: connection.storeId,
        vendor: 'square',
        externalAccountId: connection.externalAccountId,
        externalLocationId: connection.externalLocationId,
        accessTokenCiphertext: encryptToken(refreshed.accessToken, encryptionKey),
        refreshTokenCiphertext: encryptToken(refreshed.refreshToken, encryptionKey),
        tokenExpiresAt: refreshed.expiresAt,
        ...(connection.connectedByUserId !== null ? { connectedByUserId: connection.connectedByUserId } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Square token refresh failed.';
      await connectionRepository.updateStatus(connection.id, 'EXPIRED' satisfies PosConnectionStatus, message);
      throw err;
    }
  }

  // The window's start: the connection's own watermark if a prior sync completed at least one
  // page, else 90 days back — matching the plan's acceptance criterion ("90 days of orders sync")
  // for a store's FIRST sync, when no watermark exists yet.
  const since = connection.ordersSyncWatermark ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  try {
    const result = await runOrdersWindow(db, organizationId, storeId, config, accessToken, connection, since, { advanceCursor: true });
    await connectionRepository.recordSuccessfulSync(connection.id);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Square orders sync failed.';
    await connectionRepository.updateStatus(connection.id, 'DEGRADED' satisfies PosConnectionStatus, message);
    throw err;
  }
};

const RECONCILIATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * the nightly reconciliation sweep. the plan's own reasoning: webhooks are best-effort at
 * every vendor, and a missed one is otherwise invisible — "occur routinely in production and none
 * of which announce themselves." Re-fetches a trailing 3-day window UNCONDITIONALLY, regardless of
 * the connection's own `ordersSyncWatermark` — a real gap could be older than the incremental
 * sync's own window would ever revisit, and the whole point of reconciliation is to catch that
 * without trusting the state it might itself be wrong about.
 *
 * Deliberately does NOT advance `ordersSyncCursor`/`ordersSyncWatermark` — those belong solely to
 * the incremental sync's own progress. A reconciliation run sharing that state would silently
 * fast-forward the real watermark to "now" every night, masking exactly the class of gap (an old
 * missed webhook, a vendor-side correction) this sweep exists to find. Reuses the exact same
 * per-order recording/refund-detection path as `syncSquareOrders` — `.onConflictDoNothing()`
 * makes re-seeing an already-recorded order a genuine no-op, and `processRefundIfNew`
 * already only reacts to an incremental refund delta, so running this nightly on top of a
 * healthy incremental sync costs nothing beyond the re-fetch itself.
 */
export const reconcileSquareOrders = async (
  db: Db,
  organizationId: string,
  storeId: string,
  config: SquareOAuthConfig,
  encryptionKey: string | undefined
): Promise<SquareReconciliationResult> => {
  const connectionRepository = new PosConnectionRepository(db, organizationId);
  const connection = await connectionRepository.findByStoreAndVendor(storeId, 'square');
  if (!connection) {
    throw new SquareNotConnectedError();
  }
  if (!connection.externalLocationId) {
    throw new SquareLocationMissingError();
  }

  let accessToken = decryptToken(connection.accessTokenCiphertext, encryptionKey);
  const tokenExpired = connection.tokenExpiresAt !== null && connection.tokenExpiresAt <= new Date();
  if (tokenExpired && connection.refreshTokenCiphertext) {
    try {
      const refreshed = await refreshSquareToken(config, decryptToken(connection.refreshTokenCiphertext, encryptionKey));
      accessToken = refreshed.accessToken;
      await connectionRepository.upsert({
        id: connection.id,
        storeId: connection.storeId,
        vendor: 'square',
        externalAccountId: connection.externalAccountId,
        externalLocationId: connection.externalLocationId,
        accessTokenCiphertext: encryptToken(refreshed.accessToken, encryptionKey),
        refreshTokenCiphertext: encryptToken(refreshed.refreshToken, encryptionKey),
        tokenExpiresAt: refreshed.expiresAt,
        ...(connection.connectedByUserId !== null ? { connectedByUserId: connection.connectedByUserId } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Square token refresh failed.';
      await connectionRepository.updateStatus(connection.id, 'EXPIRED' satisfies PosConnectionStatus, message);
      throw err;
    }
  }

  const since = new Date(Date.now() - RECONCILIATION_WINDOW_MS);

  try {
    // recordSuccessfulSync deliberately NOT called here — this sweep isn't "the sync" from the
    // health surface's point of view, and unconditionally marking the connection healthy on every
    // nightly run would hide a REAL, ongoing incremental-sync failure that reconciliation alone
    // can't fix (reconciliation only ever adds orders on top of whatever incremental sync already
    // achieved; it can't repair a broken token or a bad location id).
    return await runOrdersWindow(db, organizationId, storeId, config, accessToken, connection, since, { advanceCursor: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Square reconciliation sweep failed.';
    await connectionRepository.updateStatus(connection.id, 'DEGRADED' satisfies PosConnectionStatus, message);
    throw err;
  }
};

/**
 * The shared page-draining loop both `syncSquareOrders` and `reconcileSquareOrders` run: fetch a
 * page, record every order + lines + outbox event idempotently in one transaction, detect/reverse
 * refunds on orders that already existed, trigger consumption for anything newly recorded, repeat
 * until the cursor drains. `advanceCursor` is the only behavioral difference between the two
 * callers — when `false` (reconciliation), `posConnections.ordersSyncCursor`/`ordersSyncWatermark`
 * are read but never written, so a reconciliation run cannot perturb the incremental sync's own
 * progress.
 */
const runOrdersWindow = async (
  db: Db,
  organizationId: string,
  storeId: string,
  config: SquareOAuthConfig,
  accessToken: string,
  connection: { id: string; externalLocationId: string | null; ordersSyncCursor: string | null; ordersSyncWatermark: Date | null },
  since: Date,
  options: { advanceCursor: boolean }
): Promise<SquareOrdersSyncResult> => {
  // Both callers already threw SquareLocationMissingError before reaching here — this is a real
  // invariant, not a defensive fallback, so a null here means a caller-side bug, not bad data.
  if (!connection.externalLocationId) {
    throw new SquareLocationMissingError();
  }
  const externalLocationId = connection.externalLocationId;

  // Captured once, BEFORE the first fetch — this run's final watermark, regardless of how many
  // pages it takes to drain the cursor. An order updated mid-run by a concurrent webhook is still
  // caught by the NEXT run's window, rather than falling just before a too-precise watermark taken
  // from the last order actually seen. Unused when advanceCursor is false.
  const runStartedAt = new Date();

  // Reconciliation always starts from its own fixed `since`, never from the connection's cursor —
  // a stray leftover cursor from a DIFFERENT window would desync the reconciliation page walk from
  // the 3-day window it's supposed to be draining.
  let cursor = options.advanceCursor ? connection.ordersSyncCursor ?? undefined : undefined;
  let ordersSeen = 0;
  let transactionsRecorded = 0;
  let transactionsDuplicate = 0;
  let refundsProcessed = 0;
  const newlyRecordedTransactionIds: string[] = [];

  do {
    const page = await fetchSquareOrders(config, accessToken, externalLocationId, since, cursor);
    ordersSeen += page.items.length;

    const pageOutcomes = await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        const outcomes: Array<{ order: ExternalTransaction; recordedTransactionId: string | null }> = [];
        for (const order of page.items) {
          const recordedTransactionId = await recordOrderInTx(tx, organizationId, storeId, order);
          outcomes.push({ order, recordedTransactionId });
          if (recordedTransactionId) transactionsRecorded += 1;
          else transactionsDuplicate += 1;
        }

        if (options.advanceCursor) {
          await tx
            .update(posConnections)
            .set({
              ordersSyncCursor: page.nextCursor ?? null,
              ordersSyncWatermark: page.nextCursor === undefined ? runStartedAt : connection.ordersSyncWatermark,
              updatedAt: new Date(),
            })
            .where(eq(posConnections.id, connection.id));
        }

        return outcomes;
      })
    );

    for (const { order, recordedTransactionId } of pageOutcomes) {
      if (recordedTransactionId) {
        newlyRecordedTransactionIds.push(recordedTransactionId);
        continue;
      }
      // A duplicate (order already existed) is exactly the case a refund shows up as — Square
      // reports the refund on the SAME order id, which onConflictDoNothing correctly recognized
      // as "already have this order" rather than a new sale. Check whether this order now carries
      // a refund the prior sync didn't see.
      if (order.refundedAmount !== undefined) {
        const processed = await processRefundIfNew(db, organizationId, storeId, order);
        if (processed) refundsProcessed += 1;
      }
    }

    cursor = page.nextCursor;
  } while (cursor !== undefined);

  for (const transactionId of newlyRecordedTransactionIds) {
    await triggerConsumptionForTransaction(db, organizationId, storeId, transactionId);
  }

  return { ordersSeen, transactionsRecorded, transactionsDuplicate, refundsProcessed };
};

/**
 * Writes one order's header + lines + outbox event inside the CALLER's already-open transaction —
 * never opens its own. Idempotent via `.onConflictDoNothing()` on `sales_transactions`' real unique
 * index; returns `null` (not an error) for a duplicate, matching
 * `SalesTransactionRepository.recordIfNew`'s own `'duplicate'`-vs-`'recorded'` convention so a
 * re-synced window (the normal case for an incremental sync with any overlap) doesn't miscount.
 * Returns the new row's id on success so the caller can trigger consumption for it AFTER this
 * transaction commits.
 */
const recordOrderInTx = async (
  tx: Tx,
  organizationId: string,
  storeId: string,
  order: ExternalTransaction
): Promise<string | null> => {
  const check = order.checks[0];
  if (!check) return null;

  const transactionId = generateId();
  const inserted = await tx
    .insert(salesTransactions)
    .values({
      id: transactionId,
      organizationId,
      storeId,
      source: 'square',
      externalId: order.externalId,
      occurredAt: order.occurredAt,
      ...(order.channel !== undefined ? { channel: order.channel } : {}),
      subtotal: check.subtotal.amount,
      discount: check.discount.amount,
      tax: check.tax.amount,
      total: check.total.amount,
      currency: check.total.currency,
      status: order.status === 'completed' ? 'COMPLETED' : 'VOIDED',
    })
    .onConflictDoNothing({
      target: [salesTransactions.organizationId, salesTransactions.source, salesTransactions.externalId],
    })
    .returning();

  const created = inserted[0];
  if (!created) return null;

  for (const line of check.lines) {
    const posItemRows = await tx
      .select({ id: posItems.id })
      .from(posItems)
      .where(and(eq(posItems.organizationId, organizationId), eq(posItems.storeId, storeId), eq(posItems.source, 'square'), eq(posItems.externalId, line.posItemExternalId)));

    await tx.insert(salesTransactionLines).values({
      id: generateId(),
      organizationId,
      transactionId: created.id,
      ...(posItemRows[0] !== undefined ? { posItemId: posItemRows[0].id } : {}),
      quantity: line.quantity,
      unitPrice: line.unitPrice.amount,
      discount: line.discount.amount,
      lineTotal: line.lineTotal.amount,
      ...(line.modifiers.length > 0 ? { modifiers: line.modifiers } : {}),
    });
  }

  await tx.insert(outboxEvents).values({
    id: generateId(),
    organizationId,
    aggregateType: 'sales_transaction',
    aggregateId: created.id,
    eventType: 'sales.ingested',
    payload: { transactionId: created.id, storeId, source: 'square', externalId: order.externalId },
  });

  return created.id;
};

/**
 * called once per newly-recorded `COMPLETED` `sales_transactions` row, AFTER its
 * recording transaction has committed — `SalesIngestionPipeline` opens its own transaction per
 * line, so it cannot run inside `recordOrderInTx`'s transaction (see this file's own top-level
 * comment). A `menuItemId` is resolved from `pos_items.menuItemId`/`mappingStatus`: `'MAPPED'`
 * consumes via the real recipe; anything else (`'UNMAPPED'`/`'IGNORED'`, or a line whose
 * `posItemId` never resolved during recording) quarantines instead — `SalesIngestionPipeline`
 * itself already encodes that branch (I7, earlier work), this function just supplies which branch based
 * on what THIS line's `pos_items` row actually says today, matching the sale's own line quantities
 * and revenue exactly rather than recomputing from the recipe.
 */
const triggerConsumptionForTransaction = async (
  db: Db,
  organizationId: string,
  storeId: string,
  transactionId: string
): Promise<void> => {
  // A plain read, but still against RLS-protected tables — needs app.current_org_id set the same
  // way every TenantScopedRepository query does, even though this join isn't itself a repository
  // method. withTenantContext requires an open transaction (SET LOCAL's own scope), so this read
  // gets its own short-lived one, separate from both recordOrderInTx's transaction (already
  // committed by the time this runs) and whatever transaction SalesIngestionPipeline opens next.
  const rows = await db.transaction((tx) =>
    withTenantContext(tx, organizationId, () =>
      tx
        .select({
          lineId: salesTransactionLines.id,
          quantity: salesTransactionLines.quantity,
          lineTotal: salesTransactionLines.lineTotal,
          currency: salesTransactions.currency,
          occurredAt: salesTransactions.occurredAt,
          menuItemId: posItems.menuItemId,
          mappingStatus: posItems.mappingStatus,
          posItemExternalId: posItems.externalId,
          posItemName: posItems.name,
        })
        .from(salesTransactionLines)
        .innerJoin(salesTransactions, eq(salesTransactionLines.transactionId, salesTransactions.id))
        .leftJoin(posItems, eq(salesTransactionLines.posItemId, posItems.id))
        .where(and(eq(salesTransactionLines.organizationId, organizationId), eq(salesTransactionLines.transactionId, transactionId)))
    )
  );

  const pipeline = new SalesIngestionPipeline(db, organizationId);
  for (const row of rows) {
    const menuItemId = row.mappingStatus === 'MAPPED' ? row.menuItemId : null;
    await pipeline.ingestSaleLine({
      storeId,
      menuItemId,
      posItemExternalId: row.posItemExternalId ?? row.lineId,
      posItemName: row.posItemName ?? 'Unrecognized item',
      quantitySold: row.quantity,
      revenue: row.lineTotal,
      currency: row.currency as CurrencyCode,
      occurredAt: row.occurredAt,
      sourceType: 'pos-sync',
      sourceId: transactionId,
    });
  }
};

/**
 * detects a refund on an order this codebase already recorded in
 * a PRIOR sync — the current sync's `recordOrderInTx` correctly treated it as a duplicate
 * (`onConflictDoNothing`, same `external_id`), which is exactly how Square represents a refund: an
 * addition to the SAME order object, not a new one. Idempotent by construction: the REFUNDED row's
 * `external_id` is deterministic (`${orderExternalId}:refund`), so re-processing the same refund
 * amount is a genuine no-op (its own `onConflictDoNothing` on first sight, or an `UPDATE` that sets
 * the same total again on a later sight — never a duplicate reversal, since the delta is computed
 * from what the row ALREADY says, not reapplied blindly).
 *
 * Partial refunds reverse PROPORTIONALLY: the fraction is
 * `refundedAmount / originalTotal`, applied only to the INCREMENTAL amount newly refunded since the
 * last time this function saw this order — a second, later partial refund on the same order posts
 * only the additional reversal, not a second full one.
 */
const processRefundIfNew = async (
  db: Db,
  organizationId: string,
  storeId: string,
  order: ExternalTransaction
): Promise<boolean> => {
  if (!order.refundedAmount) return false;

  const refundExternalId = `${order.externalId}:refund`;
  const movementService = new MovementService(db, organizationId);

  return db.transaction((tx) =>
    withTenantContext(tx, organizationId, async () => {
      const originalRows = await tx
        .select()
        .from(salesTransactions)
        .where(and(eq(salesTransactions.organizationId, organizationId), eq(salesTransactions.source, 'square'), eq(salesTransactions.externalId, order.externalId)));
      const original = originalRows[0];
      if (!original || original.status !== 'COMPLETED') return false; // nothing to refund against, or already voided

      const existingRefundRows = await tx
        .select()
        .from(salesTransactions)
        .where(and(eq(salesTransactions.organizationId, organizationId), eq(salesTransactions.source, 'square'), eq(salesTransactions.externalId, refundExternalId)));
      const existingRefund = existingRefundRows[0];

      const newRefundedTotal = new Decimal(order.refundedAmount!.amount);
      const priorRefundedTotal = existingRefund ? new Decimal(existingRefund.total) : new Decimal(0);
      const incrementalRefund = newRefundedTotal.minus(priorRefundedTotal);
      if (incrementalRefund.lte(0)) return false; // nothing new — same or smaller amount than already recorded

      const originalTotal = new Decimal(original.total);
      const incrementalFraction = originalTotal.isZero() ? new Decimal(0) : incrementalRefund.dividedBy(originalTotal);

      if (existingRefund) {
        await tx
          .update(salesTransactions)
          .set({ total: newRefundedTotal.toFixed(4), updatedAt: new Date() })
          .where(eq(salesTransactions.id, existingRefund.id));
      } else {
        await tx.insert(salesTransactions).values({
          id: generateId(),
          organizationId,
          storeId,
          source: 'square',
          externalId: refundExternalId,
          occurredAt: order.occurredAt,
          subtotal: '0.0000',
          discount: '0.0000',
          tax: '0.0000',
          total: newRefundedTotal.toFixed(4),
          currency: original.currency,
          status: 'REFUNDED',
          refundOfId: original.id,
        });
      }

      await movementService.reverseSaleConsumption(tx, {
        originalSourceId: original.id,
        fraction: incrementalFraction.toString(),
        occurredAt: new Date(),
        sourceType: 'pos-sync-refund',
        sourceId: original.id,
      });

      return true;
    })
  );
};
