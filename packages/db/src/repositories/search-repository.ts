import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { products } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

export type SearchEntityType = 'product' | 'supplier' | 'purchase_order' | 'document';

export type SearchResultRow = {
  entityType: SearchEntityType;
  id: string;
  title: string;
  subtitle: string | null;
  score: number;
};

/**
 * 009-17/009-18 (spec 11 §11.3/§11.4/§11.5) — global search across the four MVP-relevant entities
 * (products, suppliers, purchase orders, documents): lexical (FTS + trigram, 009-17) for all four,
 * plus vector similarity over `document_embeddings` (009-18) for documents specifically — the only
 * entity this project generates embeddings for (see `document-embedding-repository.ts`'s own header
 * for why: no other entity has a real free-text corpus worth embedding yet).
 *
 * Every method issues its own real SQL against the tables/indexes `0041_search.sql`/
 * `0042_document_embeddings.sql` created — no ORM query builder abstraction layered on top, since
 * Postgres FTS/trigram/pgvector operators (`%`, `@@`, `plainto_tsquery`, `similarity`, `<=>`) have
 * no first-class representation in Drizzle 0.36's builder. Every query is parameterized (spec 11
 * §11.7 rule 5 — user text never reaches SQL as a raw fragment) via `sql` tagged-template
 * interpolation, which `postgres` binds as a real parameter, never string-concatenated.
 *
 * Deliberately extends `TenantScopedRepository<typeof products>` (matching `DashboardRepository`'s
 * own precedent for a repository that reads several tables) — every OTHER table's tenant predicate
 * is built by hand against that table's own `organization_id`, since `scopedWhere` is bound only to
 * `products`.
 */
export class SearchRepository extends TenantScopedRepository<typeof products> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, products, organizationId);
  }

  /**
   * Products: exact SKU match scores highest, then trigram similarity on name (typo tolerance),
   * then FTS rank on the combined name+SKU vector — matching spec 11 §11.3's own literal formula.
   * `p.deleted_at IS NULL` excludes soft-deleted products (a search result pointing at a
   * soft-deleted row would be a dead link).
   */
  async searchProducts(query: string, limit: number): Promise<SearchResultRow[]> {
    return this.runScoped((db) =>
      db.execute<{ id: string; name: string; sku: string; score: number }>(sql`
        SELECT p.id, p.name, p.sku,
          GREATEST(
            CASE WHEN p.sku = ${query} THEN 1.0 ELSE 0 END,
            similarity(p.name, ${query}) * 0.9,
            ts_rank(p.search_vector, plainto_tsquery('english', ${query})) * 0.7
          ) AS score
        FROM products p
        WHERE p.organization_id = ${this.organizationId}
          AND p.deleted_at IS NULL
          AND (p.sku = ${query} OR p.name % ${query} OR p.search_vector @@ plainto_tsquery('english', ${query}))
        ORDER BY score DESC
        LIMIT ${limit}
      `)
    ).then((rows) => rows.map((row) => ({ entityType: 'product' as const, id: row.id, title: row.name, subtitle: row.sku, score: Number(row.score) })));
  }

  /** Suppliers: trigram on name + FTS on the same field — no exact-identifier field exists on suppliers (no SKU-equivalent), matching spec 11 §11.3's own "Name (trigram)" framing. */
  async searchSuppliers(query: string, limit: number): Promise<SearchResultRow[]> {
    return this.runScoped((db) =>
      db.execute<{ id: string; name: string; score: number }>(sql`
        SELECT s.id, s.name,
          GREATEST(
            similarity(s.name, ${query}) * 0.9,
            ts_rank(s.search_vector, plainto_tsquery('english', ${query})) * 0.7
          ) AS score
        FROM suppliers s
        WHERE s.organization_id = ${this.organizationId}
          AND s.deleted_at IS NULL
          AND (s.name % ${query} OR s.search_vector @@ plainto_tsquery('english', ${query}))
        ORDER BY score DESC
        LIMIT ${limit}
      `)
    ).then((rows) => rows.map((row) => ({ entityType: 'supplier' as const, id: row.id, title: row.name, subtitle: null, score: Number(row.score) })));
  }

  /**
   * Purchase orders: PO number is the one field users search constantly (spec 11 §11.3), so an
   * exact match scores highest, then trigram similarity for a partially-remembered number.
   * `s.name` (the supplier) is joined in only for the result's subtitle — never part of the score,
   * since matching "find PO-1042" shouldn't also surface every PO from a supplier named similarly.
   */
  async searchPurchaseOrders(query: string, limit: number): Promise<SearchResultRow[]> {
    return this.runScoped((db) =>
      db.execute<{ id: string; po_number: string; supplier_name: string; score: number }>(sql`
        SELECT po.id, po.po_number, s.name AS supplier_name,
          GREATEST(
            CASE WHEN po.po_number = ${query} THEN 1.0 ELSE 0 END,
            similarity(po.po_number, ${query}) * 0.9
          ) AS score
        FROM purchase_orders po
        INNER JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.organization_id = ${this.organizationId}
          AND (po.po_number = ${query} OR po.po_number % ${query})
        ORDER BY score DESC
        LIMIT ${limit}
      `)
    ).then((rows) => rows.map((row) => ({ entityType: 'purchase_order' as const, id: row.id, title: row.po_number, subtitle: row.supplier_name, score: Number(row.score) })));
  }

  /**
   * Documents: exact match on the extracted document number (the highest-value, most-searched
   * field per spec 11 §11.3), plus a case-insensitive substring match on the extracted supplier
   * name — reusing `DocumentRepository.search`'s own established `LIKE` pattern for this same
   * jsonb field (007-13), since `document_extractions.fields` is unstructured jsonb, not a real
   * indexed text column. The LEXICAL half of document search — the vector/semantic half
   * (`searchDocumentsByVector`, below) is 009-18's addition, and `search.hybrid`
   * (`apps/api/src/trpc/routers/search.ts`) fuses the two via RRF for long/conceptual queries.
   * Matches on the MOST RECENT extraction per document only (`DISTINCT ON`), matching
   * `DocumentRepository.search`'s own "at least one extraction matches" semantics but scored,
   * not just filtered.
   */
  async searchDocuments(query: string, limit: number): Promise<SearchResultRow[]> {
    const needle = `%${query.toLowerCase()}%`;
    return this.runScoped((db) =>
      db.execute<{ id: string; document_number: string | null; supplier: string | null; score: number }>(sql`
        SELECT DISTINCT ON (d.id) d.id,
          de.fields->'documentNumber'->>'value' AS document_number,
          de.fields->'supplier'->>'value' AS supplier,
          CASE
            WHEN de.fields->'documentNumber'->>'value' = ${query} THEN 1.0
            WHEN lower(de.fields->'documentNumber'->>'value') LIKE ${needle} THEN 0.8
            WHEN lower(de.fields->'supplier'->>'value') LIKE ${needle} THEN 0.6
            ELSE 0
          END AS score
        FROM documents d
        INNER JOIN document_extractions de ON de.document_id = d.id
        WHERE d.organization_id = ${this.organizationId}
          AND d.deleted_at IS NULL
          AND (
            de.fields->'documentNumber'->>'value' = ${query}
            OR lower(de.fields->'documentNumber'->>'value') LIKE ${needle}
            OR lower(de.fields->'supplier'->>'value') LIKE ${needle}
          )
        ORDER BY d.id, de.extracted_at DESC
      `)
    ).then((rows) =>
      rows
        .map((row) => ({
          entityType: 'document' as const,
          id: row.id,
          title: row.document_number ?? 'Untitled document',
          subtitle: row.supplier,
          score: Number(row.score),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    );
  }

  /**
   * The vector half of document search (009-18, spec 11 §11.5) — cosine distance (`<=>`) against
   * `document_embeddings.embedding`, HNSW-indexed (`0042_document_embeddings.sql`), ordered
   * nearest-first. Only documents with a real embedding row are candidates — a document never yet
   * approved (no embedding generated, `apps/worker`'s embedding job only runs on APPROVED) is
   * simply absent from vector results, never scored as "no match" via a fabricated worst-possible
   * distance. `document_embeddings.document_id` is UNIQUE (schema constraint), so this query is
   * already one row per document — no `DISTINCT ON` needed, unlike `searchDocuments`' multi-
   * extraction-history case.
   */
  async searchDocumentsByVector(queryEmbedding: number[], limit: number): Promise<{ id: string; rank: number; title: string; subtitle: string | null }[]> {
    const vectorLiteral = `[${queryEmbedding.join(',')}]`;
    const rows = await this.runScoped((db) =>
      db.execute<{ document_id: string; document_number: string | null; supplier: string | null }>(sql`
        SELECT de_emb.document_id,
          de.fields->'documentNumber'->>'value' AS document_number,
          de.fields->'supplier'->>'value' AS supplier
        FROM document_embeddings de_emb
        INNER JOIN documents d ON d.id = de_emb.document_id
        LEFT JOIN LATERAL (
          SELECT fields FROM document_extractions
          WHERE document_id = de_emb.document_id
          ORDER BY extracted_at DESC LIMIT 1
        ) de ON true
        WHERE de_emb.organization_id = ${this.organizationId}
          AND d.deleted_at IS NULL
        ORDER BY de_emb.embedding <=> ${vectorLiteral}::vector
        LIMIT ${limit}
      `)
    );
    return rows.map((row, i) => ({
      id: row.document_id,
      rank: i + 1,
      title: row.document_number ?? 'Untitled document',
      subtitle: row.supplier,
    }));
  }
}
