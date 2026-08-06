import { and, eq } from 'drizzle-orm';
import {
  CsvImportRepository,
  SalesIngestionPipeline,
  posItems,
  salesTransactionLines,
  salesTransactions,
  outboxEvents,
  withTenantContext,
} from '@retailos/db';
import {
  detectCsvHeaders,
  parseCsvRows,
  generateId,
  type CsvColumnMapping,
  type DetectedCsvHeaders,
  type ParsedCsvResult,
} from '@retailos/domain';
import type { db as Db } from '../trpc/context';

export class CsvImportNotFoundError extends Error {
  constructor() {
    super('CSV import not found.');
    this.name = 'CsvImportNotFoundError';
  }
}

export class CsvImportWrongStatusError extends Error {
  constructor(expected: string, actual: string) {
    super(`CSV import must be '${expected}' for this action, but is '${actual}'.`);
    this.name = 'CsvImportWrongStatusError';
  }
}

/**
 * 006-10 (plan.md Phase 5): the CSV header-detection step, run once right after the upload is
 * confirmed (mirrors `products.confirmImageUpload`'s "download the just-uploaded bytes, verify
 * server-side" shape, applied to text instead of an image). Records the result on the import row
 * (`UPLOADED`, unchanged) so the mapping UI can read it back without re-downloading the file.
 */
export const detectAndRecordHeaders = async (
  db: typeof Db,
  organizationId: string,
  importId: string,
  csvText: string
): Promise<DetectedCsvHeaders> => {
  const csvImportRepository = new CsvImportRepository(db, organizationId);
  const importRow = await csvImportRepository.findById(importId);
  if (!importRow) throw new CsvImportNotFoundError();

  const detected = detectCsvHeaders(csvText);
  await csvImportRepository.recordDetectedHeaders(importId, detected);
  return detected;
};

export type CsvImportCommitResult = {
  totalRowCount: number;
  importedRowCount: number;
  quarantinedRowCount: number;
  skippedRowCount: number;
};

/**
 * 006-10: the actual import — parses every row per the human-confirmed mapping (006-10's own
 * `parseCsvRows`, pure and already tested independent of this function), writes each parsed row
 * into the SAME tables Square's `recordOrderInTx` writes (`pos_items`/`sales_transactions`/
 * `salesTransactionLines`/`outbox_events`), then triggers consumption via
 * `SalesIngestionPipeline.ingestSaleLine` for every newly-recorded row — the same two-phase shape
 * `syncSquareOrders` established (write inside one transaction per row, trigger consumption AFTER
 * that transaction commits, since `SalesIngestionPipeline` opens its own transaction internally and
 * cannot be composed into an outer one).
 *
 * A CSV row has no vendor-issued item id, unlike Square — `posItemName` (trimmed, matched
 * case-sensitively) is the natural key this codebase upserts `pos_items` on, via `source: 'csv'`.
 * Idempotency is per-row content hash (`parseCsvRows`'s own `externalId`), not per-file — the exact
 * same file re-uploaded produces the exact same hashes, so `onConflictDoNothing` on
 * `(organization_id, source, external_id)` makes the re-import a genuine no-op, same guarantee
 * Square's vendor order id provides.
 */
export const commitCsvImport = async (
  db: typeof Db,
  organizationId: string,
  importId: string,
  csvText: string
): Promise<CsvImportCommitResult> => {
  const csvImportRepository = new CsvImportRepository(db, organizationId);
  const importRow = await csvImportRepository.findById(importId);
  if (!importRow) throw new CsvImportNotFoundError();
  // MAPPED (the normal case) or IMPORTED (a deliberate re-commit, e.g. after a partial failure, or
  // simply re-running the same import) are both allowed — the whole point of per-row content-hash
  // idempotency is that committing an already-imported file again is a safe, genuine no-op, not an
  // error. Only UPLOADED (no mapping confirmed yet) or FAILED (parsing itself failed, no valid
  // mapping to re-run) are rejected.
  if (importRow.status !== 'MAPPED' && importRow.status !== 'IMPORTED') {
    throw new CsvImportWrongStatusError('MAPPED', importRow.status);
  }
  if (!importRow.detectedHeaders || !importRow.columnMapping) {
    throw new Error('CSV import is MAPPED but missing detectedHeaders/columnMapping — a real data-integrity gap, not expected in practice.');
  }

  const detected = importRow.detectedHeaders as unknown as DetectedCsvHeaders;
  const mapping = importRow.columnMapping as unknown as CsvColumnMapping;

  let parsed: ParsedCsvResult;
  try {
    parsed = parseCsvRows(csvText, detected.headers, mapping);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CSV parsing failed.';
    await csvImportRepository.recordFailure(importId, message);
    throw err;
  }

  const newlyRecordedTransactionIds: string[] = [];
  let importedRowCount = 0;

  for (const row of parsed.rows) {
    const recordedTransactionId = await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        // Upsert the pos_items row by (store, source='csv', externalId=trimmed name) — a CSV row
        // has no vendor SKU id, so the item's own name is this source's natural key, matching
        // PosItemRepository.upsert's shape but written raw here (same reasoning as
        // square-orders-sync.ts's recordOrderInTx: composing an already-transacted repository call
        // into this hand-opened transaction would silently run as two commits, not one).
        const posItemExternalId = row.posItemName;
        const existingPosItem = await tx
          .select({ id: posItems.id })
          .from(posItems)
          .where(
            and(
              eq(posItems.organizationId, organizationId),
              eq(posItems.storeId, importRow.storeId),
              eq(posItems.source, 'csv'),
              eq(posItems.externalId, posItemExternalId)
            )
          );
        let posItemId = existingPosItem[0]?.id;
        if (!posItemId) {
          posItemId = generateId();
          await tx.insert(posItems).values({
            id: posItemId,
            organizationId,
            storeId: importRow.storeId,
            source: 'csv',
            externalId: posItemExternalId,
            name: row.posItemName,
            price: row.unitPrice,
            currency: row.currency,
            mappingStatus: 'UNMAPPED',
          });
        } else {
          await tx
            .update(posItems)
            .set({ lastSeenAt: new Date(), updatedAt: new Date() })
            .where(eq(posItems.id, posItemId));
        }

        const transactionId = generateId();
        const insertedTx = await tx
          .insert(salesTransactions)
          .values({
            id: transactionId,
            organizationId,
            storeId: importRow.storeId,
            source: 'csv',
            externalId: row.externalId,
            occurredAt: row.occurredAt,
            subtotal: row.lineTotal,
            discount: row.discount,
            tax: '0.0000',
            total: row.lineTotal,
            currency: row.currency,
            status: 'COMPLETED',
          })
          .onConflictDoNothing({
            target: [salesTransactions.organizationId, salesTransactions.source, salesTransactions.externalId],
          })
          .returning();

        const created = insertedTx[0];
        if (!created) return null; // duplicate row (a re-uploaded file) — genuine no-op, matching Square's own idempotency proof

        await tx.insert(salesTransactionLines).values({
          id: generateId(),
          organizationId,
          transactionId: created.id,
          posItemId,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          discount: row.discount,
          lineTotal: row.lineTotal,
        });

        await tx.insert(outboxEvents).values({
          id: generateId(),
          organizationId,
          aggregateType: 'sales_transaction',
          aggregateId: created.id,
          eventType: 'sales.ingested',
          payload: { transactionId: created.id, storeId: importRow.storeId, source: 'csv', externalId: row.externalId },
        });

        return created.id;
      })
    );

    if (recordedTransactionId) {
      newlyRecordedTransactionIds.push(recordedTransactionId);
      importedRowCount += 1;
    }
  }

  let quarantinedRowCount = 0;
  for (const transactionId of newlyRecordedTransactionIds) {
    const quarantinedCount = await triggerConsumptionForCsvTransaction(db, organizationId, importRow.storeId, transactionId);
    quarantinedRowCount += quarantinedCount;
  }

  const result: CsvImportCommitResult = {
    totalRowCount: parsed.rows.length + parsed.issues.length,
    importedRowCount,
    quarantinedRowCount,
    skippedRowCount: parsed.issues.length,
  };

  await csvImportRepository.recordImportResult(importId, result);
  return result;
};

/**
 * Mirrors `square-orders-sync.ts`'s `triggerConsumptionForTransaction` exactly (same reasoning: a
 * plain read against RLS-protected tables needs its own `withTenantContext`-wrapped transaction,
 * even though this join isn't a repository method) — the only difference is the caller passes a
 * single already-known `transactionId` from THIS import, not every line of an arbitrary
 * transaction. Returns how many of this transaction's lines were quarantined (unmapped), so the
 * caller can report a real `quarantinedRowCount` rather than a guess.
 */
const triggerConsumptionForCsvTransaction = async (
  db: typeof Db,
  organizationId: string,
  storeId: string,
  transactionId: string
): Promise<number> => {
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
  let quarantinedCount = 0;
  for (const row of rows) {
    const menuItemId = row.mappingStatus === 'MAPPED' ? row.menuItemId : null;
    const result = await pipeline.ingestSaleLine({
      storeId,
      menuItemId,
      posItemExternalId: row.posItemExternalId ?? row.lineId,
      posItemName: row.posItemName ?? 'Unrecognized item',
      quantitySold: row.quantity,
      revenue: row.lineTotal,
      currency: row.currency as Parameters<typeof pipeline.ingestSaleLine>[0]['currency'],
      occurredAt: row.occurredAt,
      sourceType: 'csv-import',
      sourceId: transactionId,
    });
    if (result.status === 'quarantined') quarantinedCount += 1;
  }
  return quarantinedCount;
};
