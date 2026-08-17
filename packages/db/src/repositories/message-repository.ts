import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { messages, type MessageRole } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

/**
 * `messages.organizationId` (see the schema file's own comment for why it exists despite
 * a first literal sketch omitting it) makes this a plain `TenantScopedRepository` subclass, same
 * shape as `ConversationRepository` — no join-based tenant predicate needed.
 */
export type CreateMessageInput = {
  conversationId: string;
  role: MessageRole;
  content: string;
  groundingBundle?: unknown;
  modelVersion?: string;
  promptVersion?: string;
  catalogVersion?: string;
  validationResult?: unknown;
};

export class MessageRepository extends TenantScopedRepository<typeof messages> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, messages, organizationId);
  }

  async create(input: CreateMessageInput): Promise<{ id: string }> {
    const id = generateId();
    await this.runScoped(async (db) => {
      await db.insert(messages).values({
        id,
        organizationId: this.organizationId,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        ...(input.groundingBundle !== undefined ? { groundingBundle: input.groundingBundle } : {}),
        ...(input.modelVersion !== undefined ? { modelVersion: input.modelVersion } : {}),
        ...(input.promptVersion !== undefined ? { promptVersion: input.promptVersion } : {}),
        ...(input.catalogVersion !== undefined ? { catalogVersion: input.catalogVersion } : {}),
        ...(input.validationResult !== undefined ? { validationResult: input.validationResult } : {}),
      });
    });
    return { id };
  }

  /** Oldest first — a conversation transcript reads chronologically, unlike list views (newest first). */
  async findForConversation(conversationId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(messages)
        .where(scopedWhere(eq(messages.conversationId, conversationId)))
        .orderBy(asc(messages.createdAt))
    );
  }
}
