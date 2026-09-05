import { describe, expect, it, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import type { Job } from 'bullmq';
import {
  createDb,
  organizations,
  stores,
  users,
  documents,
  documentExtractions,
  documentEmbeddings,
  documentChunkEmbeddings,
  auditLogs,
  outboxEvents,
  DocumentRepository,
  withTenantContext,
} from '@retailos/db';
import { createEmbeddingProcessor } from './embedding-processor';
import type { EmbeddingJobData } from '@retailos/queue';
import { EMBEDDING_MODEL } from '@retailos/ai';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const asJob = (data: EmbeddingJobData): Job<EmbeddingJobData> => ({ data }) as Job<EmbeddingJobData>;

const FAKE_VALUES = Array.from({ length: 768 }, (_, i) => i / 768);
const fakeEmbed = async (_apiKey: string, _text: string) => ({ model: 'fake-embedding-v1', values: FAKE_VALUES });

/**
 * real Postgres proof of the embedding processor's own orchestration (build text from the
 * real latest extraction → embed via an injected FAKE provider, matching
 * `extraction-processor.test.ts`'s own established "fake provider, real everything else"
 * precedent — a real Gemini call would be slow/rate-limited and this test is about the processor's
 * wiring, not Gemini's embedding quality) → upsert a real row into `document_embeddings`.
 */
describe('embedding processor', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(documentEmbeddings).where(eq(documentEmbeddings.organizationId, orgId));
      await adminDb.delete(documentChunkEmbeddings).where(eq(documentChunkEmbeddings.organizationId, orgId));
      await adminDb.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(documents).where(eq(documents.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
    for (const userId of createdUserIds) {
      await adminDb.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  const seedUser = async (): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `embed-test-${userId}@example.test` });
    return userId;
  };

  it('embeds a real APPROVED document\'s latest extraction, writing a real document_embeddings row', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Embed Test Org', slug: `embed-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'UTC' })
      )
    );

    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/embed.pdf`, contentHash: `embed-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { supplier: { value: 'Flour Co' }, documentNumber: { value: 'INV-1' } },
      lines: [{ description: { value: 'Type 55 Flour' } }],
      validation: { issues: [], canAutoApprove: true },
    });
    await documentRepository.updateStatus(doc.id, 'REVIEW_REQUIRED');
    await documentRepository.approve(doc.id, await seedUser());

    const processor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: 'fake-key', embedFn: fakeEmbed });
    await processor(asJob({ documentId: doc.id, organizationId }));

    const rows = await adminDb.select().from(documentEmbeddings).where(eq(documentEmbeddings.documentId, doc.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('fake-embedding-v1');
    expect(rows[0]!.sourceText).toBe('Supplier: Flour Co. Document number: INV-1. Line items: Type 55 Flour');

    // the SAME job also writes real per-chunk embeddings — one header chunk, one line-item
    // chunk, never grouped, never split.
    const chunkRows = await adminDb
      .select()
      .from(documentChunkEmbeddings)
      .where(eq(documentChunkEmbeddings.documentId, doc.id))
      .orderBy(documentChunkEmbeddings.chunkOrder);
    expect(chunkRows).toHaveLength(2);
    expect(chunkRows[0]).toMatchObject({ chunkKey: 'header', chunkType: 'header' });
    expect(chunkRows[0]!.sourceText).toContain('Flour Co');
    expect(chunkRows[1]).toMatchObject({ chunkKey: 'line-0', chunkType: 'line_item' });
    expect(chunkRows[1]!.sourceText).toContain('Type 55 Flour');
  });

  it('re-running the job for the same document replaces the embedding row, never duplicates it', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Embed Rerun Org', slug: `embed-rerun-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'UTC' })
      )
    );

    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/rerun.pdf`, contentHash: `rerun-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { supplier: { value: 'Acme' } }, lines: [], validation: { issues: [], canAutoApprove: true },
    });
    await documentRepository.updateStatus(doc.id, 'REVIEW_REQUIRED');
    await documentRepository.approve(doc.id, await seedUser());

    const processor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: 'fake-key', embedFn: fakeEmbed });
    await processor(asJob({ documentId: doc.id, organizationId }));
    await processor(asJob({ documentId: doc.id, organizationId }));

    const rows = await adminDb.select().from(documentEmbeddings).where(eq(documentEmbeddings.documentId, doc.id));
    expect(rows).toHaveLength(1);

    // re-running also replaces the chunk set, never duplicating (upsertChunks' own
    // delete-then-insert-all contract, DocumentChunkEmbeddingRepository).
    const chunkRows = await adminDb.select().from(documentChunkEmbeddings).where(eq(documentChunkEmbeddings.documentId, doc.id));
    expect(chunkRows).toHaveLength(1); // header only — this fixture has zero real lines
  });

  it('a second run with byte-identical chunk text reuses the stored embedding instead of calling the provider again — the content-hash cache', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Embed Cache Org', slug: `embed-cache-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'UTC' })
      )
    );

    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/cache.pdf`, contentHash: `cache-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { supplier: { value: 'Cache Co' }, documentNumber: { value: 'INV-CACHE' } },
      lines: [{ description: { value: 'Widget' } }],
      validation: { issues: [], canAutoApprove: true },
    });
    await documentRepository.updateStatus(doc.id, 'REVIEW_REQUIRED');
    await documentRepository.approve(doc.id, await seedUser());

    // A cache hit is only possible when the stored `model` matches the processor's real
    // EMBEDDING_MODEL constant — `fakeEmbed` above deliberately returns a DIFFERENT model string so
    // every other test in this file exercises the safe "always re-embed" default. This fixture
    // returns the real model name specifically to prove the cache path itself works.
    let callCount = 0;
    const countingRealModelEmbed = async (_apiKey: string, _text: string) => {
      callCount++;
      return { model: EMBEDDING_MODEL, values: FAKE_VALUES };
    };
    const firstProcessor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: 'fake-key', embedFn: countingRealModelEmbed });
    await firstProcessor(asJob({ documentId: doc.id, organizationId }));
    // 1 whole-document embed (DocumentEmbeddingRepository — not cached, out of this fix's scope)
    // + 2 chunk embeds (header + 1 line), all freshly computed since no cache exists yet.
    expect(callCount).toBe(3);

    const before = await adminDb
      .select()
      .from(documentChunkEmbeddings)
      .where(eq(documentChunkEmbeddings.documentId, doc.id))
      .orderBy(documentChunkEmbeddings.chunkOrder);
    expect(before).toHaveLength(2);

    // Second run over the SAME unchanged extraction — every CHUNK's text is byte-identical to what
    // was just stored, so the real provider call must be skipped entirely for both chunks. Only the
    // whole-document embed still runs (it has no cache of its own), so exactly 1 call remains.
    callCount = 0;
    const secondProcessor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: 'fake-key', embedFn: countingRealModelEmbed });
    await secondProcessor(asJob({ documentId: doc.id, organizationId }));
    expect(callCount).toBe(1); // whole-document embed only — both chunk embeds were served from cache

    const after = await adminDb
      .select()
      .from(documentChunkEmbeddings)
      .where(eq(documentChunkEmbeddings.documentId, doc.id))
      .orderBy(documentChunkEmbeddings.chunkOrder);
    expect(after).toHaveLength(2);
    // The reused row must carry the EXACT SAME vector as the original, byte-for-byte — proving the
    // cache path actually reused stored data rather than silently writing a fresh (or corrupted) one.
    expect(after[0]!.embedding).toEqual(before[0]!.embedding);
    expect(after[1]!.embedding).toEqual(before[1]!.embedding);
  });

  it('a changed line item is re-embedded for real, while the unchanged header chunk still reuses its cached embedding', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Embed Cache Partial Org', slug: `embed-cache-partial-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'UTC' })
      )
    );

    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/cache-partial.pdf`, contentHash: `cache-partial-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { supplier: { value: 'Partial Cache Co' }, documentNumber: { value: 'INV-PC' } },
      lines: [{ description: { value: 'Original Line' } }],
      validation: { issues: [], canAutoApprove: true },
    });
    await documentRepository.updateStatus(doc.id, 'REVIEW_REQUIRED');
    await documentRepository.approve(doc.id, await seedUser());

    let callCount = 0;
    const countingRealModelEmbed = async (_apiKey: string, _text: string) => {
      callCount++;
      return { model: EMBEDDING_MODEL, values: FAKE_VALUES };
    };
    const firstProcessor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: 'fake-key', embedFn: countingRealModelEmbed });
    await firstProcessor(asJob({ documentId: doc.id, organizationId }));
    expect(callCount).toBe(3); // 1 whole-document embed + 2 chunk embeds (header + 1 line)

    // A real correction changes the line item's extracted text — the header is untouched.
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v2', promptVersion: '1',
      fields: { supplier: { value: 'Partial Cache Co' }, documentNumber: { value: 'INV-PC' } },
      lines: [{ description: { value: 'Corrected Line' } }],
      validation: { issues: [], canAutoApprove: true },
    });
    await documentRepository.updateStatus(doc.id, 'APPROVED');

    callCount = 0;
    const secondProcessor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: 'fake-key', embedFn: countingRealModelEmbed });
    await secondProcessor(asJob({ documentId: doc.id, organizationId }));
    // 1 whole-document embed (always runs, uncached) + 1 real call for the CHANGED line chunk. The
    // header chunk's text is unchanged and was served from cache — proving this isn't an
    // all-or-nothing document-level check, but a genuine per-chunk comparison.
    expect(callCount).toBe(2);

    const rows = await adminDb
      .select()
      .from(documentChunkEmbeddings)
      .where(eq(documentChunkEmbeddings.documentId, doc.id))
      .orderBy(documentChunkEmbeddings.chunkOrder);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.sourceText).toContain('Corrected Line');
  });

  it('skips quietly (no row written) for a document still at REVIEW_REQUIRED, never embedding unconfirmed fields', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Embed Unapproved Org', slug: `embed-unapproved-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'UTC' })
      )
    );

    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/unapproved.pdf`, contentHash: `unapproved-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { supplier: { value: 'Acme' } }, lines: [], validation: { issues: [], canAutoApprove: false },
    });
    // Deliberately NOT approved — stays at whatever create() left it (not APPROVED/POSTED).

    const processor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: 'fake-key', embedFn: fakeEmbed });
    await processor(asJob({ documentId: doc.id, organizationId }));

    const rows = await adminDb.select().from(documentEmbeddings).where(eq(documentEmbeddings.documentId, doc.id));
    expect(rows).toHaveLength(0);
    const chunkRows = await adminDb.select().from(documentChunkEmbeddings).where(eq(documentChunkEmbeddings.documentId, doc.id));
    expect(chunkRows).toHaveLength(0);
  });

  it('a partial chunk-embed failure throws (for BullMQ to retry) and does NOT overwrite a prior complete chunk set with a smaller one', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Embed Partial-Fail Org', slug: `embed-partial-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'UTC' })
      )
    );

    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/partial.pdf`, contentHash: `partial-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { supplier: { value: 'Partial Co' }, documentNumber: { value: 'INV-9' } },
      lines: [{ description: { value: 'Line A' } }, { description: { value: 'Line B' } }],
      validation: { issues: [], canAutoApprove: true },
    });
    await documentRepository.updateStatus(doc.id, 'REVIEW_REQUIRED');
    await documentRepository.approve(doc.id, await seedUser());

    // First run: every chunk embeds successfully — a real, complete 3-chunk set (header + 2 lines).
    const goodProcessor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: 'fake-key', embedFn: fakeEmbed });
    await goodProcessor(asJob({ documentId: doc.id, organizationId }));
    const before = await adminDb.select().from(documentChunkEmbeddings).where(eq(documentChunkEmbeddings.documentId, doc.id));
    expect(before).toHaveLength(3);

    // Second run: one chunk's embed call fails (simulating a transient provider error). Matches the
    // exact per-line-chunk text shape (`buildLineText`'s "Item: Line B") — NOT a substring match —
    // so this only trips for that one chunk's own embed call, not the whole-document embed (a
    // different, longer concatenated string that also happens to mention "Line B").
    let callCount = 0;
    const flakyEmbed = async (_apiKey: string, text: string) => {
      callCount++;
      if (text.startsWith('Item: Line B')) throw new Error('simulated provider failure');
      return fakeEmbed(_apiKey, text);
    };
    const flakyProcessor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: 'fake-key', embedFn: flakyEmbed });

    await expect(flakyProcessor(asJob({ documentId: doc.id, organizationId }))).rejects.toThrow(/chunk\(s\) failed/);
    expect(callCount).toBeGreaterThan(0);

    // The prior COMPLETE 3-chunk set must still be there, untouched — not replaced by a smaller
    // partial set. This is the exact bug: upsertChunks deletes-then-inserts, so writing a partial
    // set here would silently under-index the document with no signal anywhere.
    const after = await adminDb.select().from(documentChunkEmbeddings).where(eq(documentChunkEmbeddings.documentId, doc.id));
    expect(after).toHaveLength(3);
  });

  it('skips quietly with no Gemini key configured, never attempting the call', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Embed No-Key Org', slug: `embed-nokey-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'UTC' })
      )
    );

    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/nokey.pdf`, contentHash: `nokey-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { supplier: { value: 'Acme' } }, lines: [], validation: { issues: [], canAutoApprove: true },
    });
    await documentRepository.updateStatus(doc.id, 'REVIEW_REQUIRED');
    await documentRepository.approve(doc.id, await seedUser());

    const processor = createEmbeddingProcessor({ databaseUrl: APP_CONNECTION_STRING, geminiApiKey: undefined });
    await processor(asJob({ documentId: doc.id, organizationId }));

    const rows = await adminDb.select().from(documentEmbeddings).where(eq(documentEmbeddings.documentId, doc.id));
    expect(rows).toHaveLength(0);
    const chunkRows = await adminDb.select().from(documentChunkEmbeddings).where(eq(documentChunkEmbeddings.documentId, doc.id));
    expect(chunkRows).toHaveLength(0);
  });
});
