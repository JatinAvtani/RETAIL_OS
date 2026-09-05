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
 * chunk set is regenerated wholesale on every re-approval or retry, matching
 * `DocumentEmbeddingRepository.upsert`'s own "re-embed fresh, not stale" reasoning for WHICH rows
 * survive. But the caller (the embedding worker job) uses `findExistingByChunkKey` first and skips
 * the real Gemini `embedText` call entirely for any chunk whose `sourceText` is byte-identical to
 * what's already stored — a retry after a transient provider failure, or a re-approval where only
 * one line item changed, would otherwise re-embed every unchanged chunk for no reason. This is a
 * cost/latency optimization only: `upsertChunks` itself has no opinion on whether a `values` array
 * was freshly computed or reused from cache — both write the identical row shape.
 */
export class DocumentChunkEmbeddingRepository extends TenantScopedRepository<typeof documentChunkEmbeddings> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, documentChunkEmbeddings, organizationId);
  }

  async upsertChunks(
    documentId: string,
    chunks: {
      chunkKey: string;
      chunkType: 'header' | 'line_item';
      order: number;
      model: string;
      sourceText: string;
      /** A freshly-computed embedding. Mutually exclusive with `embeddingLiteral` — exactly one must be given per chunk. */
      values?: number[];
      /** A cache-hit's own stored vector, already in pgvector's literal text form (from `findExistingByChunkKey`) — reused verbatim, no parse/re-stringify round trip. */
      embeddingLiteral?: string;
    }[]
  ): Promise<void> {
    await this.runScoped(async (db) => {
      await db.delete(documentChunkEmbeddings).where(and(eq(documentChunkEmbeddings.documentId, documentId), eq(documentChunkEmbeddings.organizationId, this.organizationId)));
      for (const chunk of chunks) {
        const vectorLiteral = chunk.embeddingLiteral ?? `[${(chunk.values ?? []).join(',')}]`;
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

  /**
   * The read side of the content-hash cache check the embedding worker job performs before calling
   * `embedText` — keyed by `chunkKey` (not `id`) since the caller compares against a freshly
   * re-chunked document, which has no row `id` yet. `embedding::text` casts pgvector's native type
   * to its own literal text representation (`[0.1,0.2,...]`) directly in SQL — the exact string
   * `upsertChunks` already accepts as a `::vector` cast on write, so a cache hit can be re-inserted
   * verbatim with zero parse/re-serialize round trip through a 768-element JS array.
   */
  async findExistingByChunkKey(documentId: string): Promise<Map<string, { sourceText: string; model: string; embeddingLiteral: string }>> {
    const rows = await this.runScoped((db) =>
      db.execute<{ chunk_key: string; source_text: string; model: string; embedding_literal: string }>(sql`
        SELECT chunk_key, source_text, model, embedding::text AS embedding_literal FROM document_chunk_embeddings
        WHERE document_id = ${documentId} AND organization_id = ${this.organizationId}
      `)
    );
    return new Map(rows.map((row) => [row.chunk_key, { sourceText: row.source_text, model: row.model, embeddingLiteral: row.embedding_literal }]));
  }
}
