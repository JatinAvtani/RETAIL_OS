import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId, type CurrencyCode } from '@retailos/domain';
import * as schema from '../schema/index';
import { salesTransactionLines, salesTransactions } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';
import type { SalesSource } from './pos-item-repository';

export type SalesTransactionLineInput = {
  posItemId?: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  lineTotal: string;
  modifiers?: unknown;
};

/**
 * 006-01's schema-task repository for `sales_transactions`/`sales_transaction_lines`. Proves the
 * idempotency unique index `(organization_id, source, external_id)` is real and load-bearing via
 * `recordIfNew`'s `onConflictDoNothing` — re-ingesting the same vendor order must not double-count
 * revenue (plan.md's exact acceptance criterion), regardless of whether the caller retried a failed
 * sync, a webhook fired twice, or the nightly reconciliation sweep re-fetched an already-seen order.
 *
 * Deliberately does NOT trigger consumption here — 006-12 wires `SalesIngestionPipeline`
 * (built in EPIC-005 specifically to wait for this table) to call this AFTER a transaction is
 * durably recorded, not as a side effect of recording it. This class's only job is the ledger of
 * sales facts itself.
 *
 * Header + lines are written in ONE transaction (via `runScoped`, which already wraps every call in
 * a transaction) — a transaction with zero lines, or lines with no transaction, would both be a
 * real data-integrity gap this codebase's I8 discipline exists to prevent for exactly this shape of
 * multi-table write.
 */
export class SalesTransactionRepository extends TenantScopedRepository<typeof salesTransactions> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, salesTransactions, organizationId);
  }

  /**
   * Records one transaction and its lines idempotently. Returns `{ status: 'recorded', ... }` on a
   * genuine first insert, or `{ status: 'duplicate' }` when `(organization, source, external_id)`
   * already exists — the caller (eventually 006-05's orders sync) uses this to distinguish "new
   * revenue" from "already counted", never inferring it from a thrown error.
   */
  async recordIfNew(input: {
    storeId: string;
    source: SalesSource;
    externalId: string;
    occurredAt: Date;
    channel?: string;
    subtotal: string;
    discount: string;
    tax: string;
    total: string;
    currency: CurrencyCode;
    lines: SalesTransactionLineInput[];
  }): Promise<{ status: 'duplicate' } | { status: 'recorded'; transactionId: string }> {
    return this.runScoped(async (db) => {
      const transactionId = generateId();
      const inserted = await db
        .insert(salesTransactions)
        .values({
          id: transactionId,
          organizationId: this.organizationId,
          storeId: input.storeId,
          source: input.source,
          externalId: input.externalId,
          occurredAt: input.occurredAt,
          ...(input.channel !== undefined ? { channel: input.channel } : {}),
          subtotal: input.subtotal,
          discount: input.discount,
          tax: input.tax,
          total: input.total,
          currency: input.currency,
        })
        .onConflictDoNothing({
          target: [salesTransactions.organizationId, salesTransactions.source, salesTransactions.externalId],
        })
        .returning();

      const created = inserted[0];
      if (!created) {
        return { status: 'duplicate' };
      }

      if (input.lines.length > 0) {
        await db.insert(salesTransactionLines).values(
          input.lines.map((line) => ({
            id: generateId(),
            organizationId: this.organizationId,
            transactionId: created.id,
            ...(line.posItemId !== undefined ? { posItemId: line.posItemId } : {}),
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discount: line.discount,
            lineTotal: line.lineTotal,
            ...(line.modifiers !== undefined ? { modifiers: line.modifiers } : {}),
          }))
        );
      }

      return { status: 'recorded', transactionId: created.id };
    });
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(salesTransactions)
        .where(scopedWhere(eq(salesTransactions.id, id)))
    );
    return rows[0] ?? null;
  }

  /**
   * `scopedWhere` (from `runScoped`) is bound to THIS repository's own table
   * (`salesTransactions`) — it cannot be reused to scope a query against the sibling
   * `sales_transaction_lines` table (its predicate would reference a column on a table absent
   * from this query's FROM clause). `sales_transaction_lines` carries its own real
   * `organization_id` column precisely so it can be predicated directly here, same
   * defense-in-depth reasoning `TenantScopedRepository` applies to its own table.
   */
  async findLines(transactionId: string) {
    return this.runScoped((db) =>
      db
        .select()
        .from(salesTransactionLines)
        .where(and(eq(salesTransactionLines.organizationId, this.organizationId), eq(salesTransactionLines.transactionId, transactionId)))
    );
  }
}
