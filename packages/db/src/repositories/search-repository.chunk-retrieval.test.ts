import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { documentChunkEmbeddings, documents, organizations, stores } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SearchRepository } from './search-repository';
import { DocumentChunkEmbeddingRepository } from './document-chunk-embedding-repository';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const flatVector = (seed: number): number[] => Array.from({ length: 768 }, (_, i) => (i === 0 ? seed : 0.001));

/**
 * (I4 — "retrieval leakage is the likeliest serious security failure in an AI product") —
 * a real, live proof that `searchDocumentChunksLexical`/`searchDocumentChunksByVector` genuinely
 * cannot see another organization's chunks, not just that the query text CONTAINS an
 * `organization_id` predicate (which the invariant scanner already checks mechanically, but a
 * scanner reading source text is not the same fact as a real cross-org query returning zero rows).
 */
describe('SearchRepository — document chunk retrieval cross-tenant isolation', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let orgA: string;
  let orgB: string;
  let storeA: string;
  let storeB: string;
  let documentA: string;
  let documentB: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    orgA = generateId();
    orgB = generateId();
    await adminDb.insert(organizations).values([
      { id: orgA, name: 'Chunk Retrieval Tenant A', slug: `chunk-retrieval-a-${orgA}`, baseCurrency: 'USD' },
      { id: orgB, name: 'Chunk Retrieval Tenant B', slug: `chunk-retrieval-b-${orgB}`, baseCurrency: 'USD' },
    ]);
    storeA = generateId();
    storeB = generateId();
    await adminDb.insert(stores).values([
      { id: storeA, organizationId: orgA, name: 'Store A', timezone: 'America/New_York' },
      { id: storeB, organizationId: orgB, name: 'Store B', timezone: 'America/New_York' },
    ]);
    documentA = generateId();
    documentB = generateId();
    await adminDb.insert(documents).values([
      { id: documentA, organizationId: orgA, storeId: storeA, type: 'INVOICE', source: 'UPLOAD', storageKey: `a/${documentA}.pdf`, contentHash: 'hash-a', mimeType: 'application/pdf', sizeBytes: 1 },
      { id: documentB, organizationId: orgB, storeId: storeB, type: 'INVOICE', source: 'UPLOAD', storageKey: `b/${documentB}.pdf`, contentHash: 'hash-b', mimeType: 'application/pdf', sizeBytes: 1 },
    ]);

    const scopedDb = createScopedDb(client);
    await new DocumentChunkEmbeddingRepository(scopedDb, orgA).upsertChunks(documentA, [
      { chunkKey: 'header', chunkType: 'header', order: 0, model: 'test-model', sourceText: 'Supplier: Confidential Tenant A Supplier', values: flatVector(0.1) },
    ]);
    await new DocumentChunkEmbeddingRepository(scopedDb, orgB).upsertChunks(documentB, [
      { chunkKey: 'header', chunkType: 'header', order: 0, model: 'test-model', sourceText: 'Supplier: Confidential Tenant B Supplier', values: flatVector(0.1) },
    ]);
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(documentChunkEmbeddings).where(eq(documentChunkEmbeddings.organizationId, orgA));
    await adminDb.delete(documentChunkEmbeddings).where(eq(documentChunkEmbeddings.organizationId, orgB));
    await adminDb.delete(documents).where(eq(documents.organizationId, orgA));
    await adminDb.delete(documents).where(eq(documents.organizationId, orgB));
    await adminDb.delete(stores).where(eq(stores.organizationId, orgA));
    await adminDb.delete(stores).where(eq(stores.organizationId, orgB));
    await adminDb.delete(organizations).where(eq(organizations.id, orgA));
    await adminDb.delete(organizations).where(eq(organizations.id, orgB));
    await client.end();
    await adminClient.end();
  });

  it("searchDocumentChunksLexical scoped to org A never returns org B's chunk, even when org B's real text matches the query", async () => {
    const db = createScopedDb(client);
    const repoA = new SearchRepository(db, orgA);

    const results = await repoA.searchDocumentChunksLexical('Confidential', 50);

    expect(results.every((r) => r.documentId !== documentB)).toBe(true);
    expect(results.some((r) => r.documentId === documentA)).toBe(true);
  });

  it("searchDocumentChunksByVector scoped to org A never returns org B's chunk, even when the query embedding is identical", async () => {
    const db = createScopedDb(client);
    const repoA = new SearchRepository(db, orgA);

    const results = await repoA.searchDocumentChunksByVector(flatVector(0.1), 50);

    expect(results.every((r) => r.documentId !== documentB)).toBe(true);
    expect(results.some((r) => r.documentId === documentA)).toBe(true);
  });

  it('the same two methods scoped to org B symmetrically never see org A — proven both directions, not just one', async () => {
    const db = createScopedDb(client);
    const repoB = new SearchRepository(db, orgB);

    const lexical = await repoB.searchDocumentChunksLexical('Confidential', 50);
    const vector = await repoB.searchDocumentChunksByVector(flatVector(0.1), 50);

    expect(lexical.every((r) => r.documentId !== documentA)).toBe(true);
    expect(vector.every((r) => r.documentId !== documentA)).toBe(true);
  });
});
