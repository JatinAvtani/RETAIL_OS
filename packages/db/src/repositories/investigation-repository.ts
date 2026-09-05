import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { investigations, type InvestigationStatus } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
  * `investigations` carries its own `organizationId` directly, matching
  * `ConversationRepository`'s shape — a plain `TenantScopedRepository` subclass.
  *
  * `createRunning`/`complete`/`fail` map to the investigation lifecycle
  * (`packages/assistant/src/investigate.ts`'s `runInvestigation`): a row is created RUNNING before
  * the (potentially slow, multi-hop) pipeline call, then updated to its real terminal state after —
  * so a crash mid-investigation leaves a real, queryable RUNNING row rather than nothing at all,
  * and `findOpenBySourceNotificationId` (the proactive sweep's own idempotency check) sees it as
  * already-in-progress rather than re-enqueuing a duplicate.
  */
export class InvestigationRepository extends TenantScopedRepository<typeof investigations> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
  super(db, investigations, organizationId);
  }

  async createRunning(input: { storeId?: string; sourceNotificationId?: string; question: string }): Promise<{ id: string }> {
    const id = generateId();
  await this.runScoped(async (db) => {
  await db.insert(investigations).values({
  id,
  organizationId: this.organizationId, ...(input.storeId !== undefined ? { storeId: input.storeId } : {}), ...(input.sourceNotificationId !== undefined ? { sourceNotificationId: input.sourceNotificationId } : {}),
  question: input.question,
  status: 'RUNNING',
  });
  });
  return { id };
  }

  /** `trace`/`draft` are the real `InvestigationStep[]`/`ActionDraftResult | null`
  * (`@retailos/assistant`) — this repository stores them as opaque JSONB, never inspecting their
  * shape (that's the assistant package's own type's job, not a db-layer concern). */
  async complete(id: string, input: { hopCount: number; trace: unknown; draft: unknown }): Promise<void> {
  await this.runScoped(async (db, scopedWhere) => {
  await db.update(investigations).set({ status: 'COMPLETE', hopCount: input.hopCount, trace: input.trace, draft: input.draft, updatedAt: new Date() }).where(scopedWhere(eq(investigations.id, id)));
  });
  }

  async fail(id: string, error: string): Promise<void> {
  await this.runScoped(async (db, scopedWhere) => {
  await db.update(investigations).set({ status: 'FAILED', error, updatedAt: new Date() }).where(scopedWhere(eq(investigations.id, id)));
  });
  }

  /**
  * A human explicitly declining a draft action — a real, distinct terminal state from `fail`
  * (a real design decision, confirmed via `AskUserQuestion`: the pipeline worked
  * correctly and produced a real draft; a human simply chose not to act on it, which is not an
  * error). `reason` is stored in the same `error` column FAILED already uses — not because a
  * rejection IS an error, but because both are real, honest "why this investigation ended without
  * a completed action" text, and a second parallel column for the identical purpose would be the
  * kind of needless duplication this codebase avoids elsewhere.
  */
  async reject(id: string, reason?: string): Promise<void> {
  await this.runScoped(async (db, scopedWhere) => {
  await db.update(investigations).set({ status: 'REJECTED', ...(reason !== undefined ? { error: reason } : {}), updatedAt: new Date() }).where(scopedWhere(eq(investigations.id, id)));
  });
  }

  async findById(id: string) {
  const rows = await this.runScoped((db, scopedWhere) => db.select().from(investigations).where(scopedWhere(eq(investigations.id, id))));
  return rows[0] ?? null;
  }

  /** The proactive sweep's own idempotency check — a notification that already has ANY
  * investigation row (RUNNING or terminal) must never get a second one enqueued. */
  async findBySourceNotificationId(sourceNotificationId: string) {
  const rows = await this.runScoped((db, scopedWhere) =>
  db.select().from(investigations).where(scopedWhere(eq(investigations.sourceNotificationId, sourceNotificationId))));
  return rows[0] ?? null;
  }

  /** The Finance Controller feed's own read path — most recent first, optionally only
  * the proactively-triggered ones (a real finding a human can open), matching the epic's own
  * "standalone page, not a chat mode" framing (on-demand investigations belong to a conversation,
  * not this feed). */
  async findRecentProactive(limit = 50) {
  return this.runScoped((db, scopedWhere) =>
  db.select().from(investigations).where(scopedWhere(and(eq(investigations.status, 'COMPLETE'), isNotNull(investigations.sourceNotificationId)))).orderBy(desc(investigations.createdAt)).limit(limit));
  }
}

export type { InvestigationStatus };
