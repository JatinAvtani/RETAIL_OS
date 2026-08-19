import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { documentChunkEmbeddings, documents, organizations, stores } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { DocumentChunkEmbeddingRepository } from './document-chunk-embedding-repository';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const flatVector = (seed: number): number[] => Array.from({ length: 768 }, (_, i) => (i === 0 ? seed : 0.001));

describe('DocumentChunkEmbeddingRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let documentId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({ id: organizationId, name: 'Chunk Embedding Test Org', slug: `chunk-embed-test-${organizationId}`, baseCurrency: 'USD' });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(documentChunkEmbeddings).where(eq(documentChunkEmbeddings.organizationId, organizationId));
    await adminDb.delete(documents).where(eq(documents.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  const seedDocument = async () => {
    const adminDb = drizzle(adminClient, { schema });
    documentId = generateId();
    await adminDb.insert(documents).values({
      id: documentId, organizationId, storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `docs/${documentId}.pdf`, contentHash: 'hash', mimeType: 'application/pdf', sizeBytes: 1024,
    });
  };

  it('upsertChunks writes a real header + line-item chunk, findByDocumentId returns both in order', async () => {
    await seedDocument();
    const repo = new DocumentChunkEmbeddingRepository(createScopedDb(client), organizationId);

    await repo.upsertChunks(documentId, [
      { chunkKey: 'header', chunkType: 'header', order: 0, model: 'test-model', sourceText: 'Supplier: Acme', values: flatVector(0.1) },
      { chunkKey: 'line-0', chunkType: 'line_item', order: 1, model: 'test-model', sourceText: 'Item: Flour', values: flatVector(0.2) },
    ]);

    const rows = await repo.findByDocumentId(documentId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ chunk_key: 'header', chunk_type: 'header', chunk_order: 0, source_text: 'Supplier: Acme' });
    expect(rows[1]).toMatchObject({ chunk_key: 'line-0', chunk_type: 'line_item', chunk_order: 1, source_text: 'Item: Flour' });
  });

  it('a second upsertChunks call REPLACES the prior chunk set, never appending or leaving stale rows behind', async () => {
    await seedDocument();
    const repo = new DocumentChunkEmbeddingRepository(createScopedDb(client), organizationId);

    await repo.upsertChunks(documentId, [
      { chunkKey: 'header', chunkType: 'header', order: 0, model: 'test-model', sourceText: 'Supplier: Old', values: flatVector(0.1) },
      { chunkKey: 'line-0', chunkType: 'line_item', order: 1, model: 'test-model', sourceText: 'Item: Old thing', values: flatVector(0.2) },
    ]);
    // Re-approval with a corrected extraction: one fewer line this time.
    await repo.upsertChunks(documentId, [
      { chunkKey: 'header', chunkType: 'header', order: 0, model: 'test-model', sourceText: 'Supplier: New', values: flatVector(0.3) },
    ]);

    const rows = await repo.findByDocumentId(documentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_text: 'Supplier: New' });
  });

  it('findByDocumentId for a document with no chunks yet returns a real empty array, never throws', async () => {
    await seedDocument();
    const repo = new DocumentChunkEmbeddingRepository(createScopedDb(client), organizationId);

    const rows = await repo.findByDocumentId(documentId);
    expect(rows).toEqual([]);
  });

  it("a document's chunks written under one org are invisible to a repository scoped to a different org — real cross-tenant isolation, not just an application-layer filter", async () => {
    const adminDb = drizzle(adminClient, { schema });
    const otherOrgId = generateId();
    await adminDb.insert(organizations).values({ id: otherOrgId, name: 'Other Org', slug: `other-org-${otherOrgId}`, baseCurrency: 'USD' });

    try {
      await seedDocument();
      const db = createScopedDb(client);
      const ownRepo = new DocumentChunkEmbeddingRepository(db, organizationId);
      await ownRepo.upsertChunks(documentId, [
        { chunkKey: 'header', chunkType: 'header', order: 0, model: 'test-model', sourceText: 'Supplier: Real Org', values: flatVector(0.1) },
      ]);

      const otherRepo = new DocumentChunkEmbeddingRepository(db, otherOrgId);
      const rows = await otherRepo.findByDocumentId(documentId);

      expect(rows).toEqual([]);
    } finally {
      await adminDb.delete(organizations).where(eq(organizations.id, otherOrgId));
    }
  });
});
