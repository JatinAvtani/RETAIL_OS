import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { documentChunkEmbeddings } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';
import { generateId } from '@retailos/domain';

/**
 * The write side of per-chunk document embeddings, matching `DocumentEmbeddingRepository`
 * — its established shape one file over. `upsertChunks` replaces the FULL current chunk set
 * for a document in one transaction (delete-then-insert-all, not a per-chunk diff) — a document's
 * chunk set is regenerated wholesale on every re-approval, matching `DocumentEmbeddingRepository
 * .upsert`'s own "re-embed fresh, not stale" reasoning; per-chunk incremental diffing (skip
 * unchanged lines) is real future scope, not built here, since `chunkDocument` gives no signal
 * about which chunks changed since a prior extraction — only the caller re-running the full
 * embedding pipeline would know that, and no caller does yet.
 */
export class DocumentChunkEmbeddingRepository extends TenantScopedRepository<typeof documentChunkEmbeddings> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, documentChunkEmbeddings, organizationId);
  }

  async upsertChunks(
    documentId: string,
    chunks: { chunkKey: string; chunkType: 'header' | 'line_item'; order: number; model: string; sourceText: string; values: number[] }[]
  ): Promise<void> {
    await this.runScoped(async (db) => {
      await db.delete(documentChunkEmbeddings).where(and(eq(documentChunkEmbeddings.documentId, documentId), eq(documentChunkEmbeddings.organizationId, this.organizationId)));
      for (const chunk of chunks) {
        const vectorLiteral = `[${chunk.values.join(',')}]`;
        await db.execute(sql`
          INSERT INTO document_chunk_embeddings (id, organization_id, document_id, chunk_key, chunk_type, chunk_order, model, source_text, embedding)
          VALUES (${generateId()}, ${this.organizationId}, ${documentId}, ${chunk.chunkKey}, ${chunk.chunkType}, ${chunk.order}, ${chunk.model}, ${chunk.sourceText}, ${vectorLiteral}::vector)
        `);
      }
    });
  }

  async findByDocumentId(documentId: string) {
    return this.runScoped((db) =>
      db.execute<{ id: string; chunk_key: string; chunk_type: 'header' | 'line_item'; chunk_order: number; source_text: string }>(sql`
        SELECT id, chunk_key, chunk_type, chunk_order, source_text FROM document_chunk_embeddings
        WHERE document_id = ${documentId} AND organization_id = ${this.organizationId}
        ORDER BY chunk_order
      `)
    );
  }
}
