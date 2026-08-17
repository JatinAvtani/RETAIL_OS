import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { documentEmbeddings } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';
import { generateId } from '@retailos/domain';

/**
 * 009-18 — the write side of document embeddings. `upsert` is delete-then-insert inside one
 * transaction (matching `FactTableWriter`'s established idempotent-rebuild pattern, 009-01) rather
 * than an `ON CONFLICT` upsert — the `embedding` vector column's equality/conflict semantics via
 * Drizzle's typed builder are exactly the class of pgvector operation with no clean builder
 * representation (`SearchRepository`'s own header comment explains this same limitation for reads).
 * A document that's re-approved (a corrected extraction) gets a genuinely fresh embedding, not a
 * stale one left over from its first approval.
 */
export class DocumentEmbeddingRepository extends TenantScopedRepository<typeof documentEmbeddings> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, documentEmbeddings, organizationId);
  }

  async upsert(input: { documentId: string; model: string; sourceText: string; values: number[] }): Promise<void> {
    const vectorLiteral = `[${input.values.join(',')}]`;
    await this.runScoped(async (db) => {
      await db.delete(documentEmbeddings).where(and(eq(documentEmbeddings.documentId, input.documentId), eq(documentEmbeddings.organizationId, this.organizationId)));
      await db.execute(sql`
        INSERT INTO document_embeddings (id, organization_id, document_id, model, source_text, embedding)
        VALUES (${generateId()}, ${this.organizationId}, ${input.documentId}, ${input.model}, ${input.sourceText}, ${vectorLiteral}::vector)
      `);
    });
  }

  async findByDocumentId(documentId: string) {
    const rows = await this.runScoped((db) =>
      db.execute<{ id: string; model: string; source_text: string }>(sql`
        SELECT id, model, source_text FROM document_embeddings
        WHERE document_id = ${documentId} AND organization_id = ${this.organizationId}
      `)
    );
    return rows[0] ?? null;
  }
}
