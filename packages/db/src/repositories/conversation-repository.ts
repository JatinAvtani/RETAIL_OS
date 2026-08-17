import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { conversations } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * `conversations` carries its own `organizationId` column directly, so
 * this is a plain `TenantScopedRepository` subclass — matching `DocumentEmbeddingRepository`'s
 * shape, not `SupplierPerformanceEventRepository`'s (which had a real transaction-composition
 * reason to be a plain class). `messages` (the child table) does NOT carry `organizationId` of its
 * own in a first literal schema sketch, so it deliberately gets a SEPARATE repository below rather
 * than reusing this class's `runScoped`/`scopedWhere` against a different table — the exact gotcha
 * this project has hit before (`scopedWhere` is bound to the constructor's own table; reusing it
 * against a different FROM clause produces a "missing FROM-clause entry" error, see
 * `SalesTransactionRepository.findLines()`'s history).
 */
export class ConversationRepository extends TenantScopedRepository<typeof conversations> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, conversations, organizationId);
  }

  async create(input: { userId: string; title?: string }): Promise<{ id: string }> {
    const id = generateId();
    await this.runScoped(async (db) => {
      await db.insert(conversations).values({
        id,
        organizationId: this.organizationId,
        userId: input.userId,
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
    });
    return { id };
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(conversations)
        .where(scopedWhere(eq(conversations.id, id)))
    );
    return rows[0] ?? null;
  }

  /** Most recent first, matching every other list view in this codebase (e.g. document search). */
  async findForUser(userId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(conversations)
        .where(scopedWhere(eq(conversations.userId, userId)))
        .orderBy(desc(conversations.createdAt))
    );
  }
}
