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
  auditLogs,
  outboxEvents,
  DocumentRepository,
  withTenantContext,
} from '@retailos/db';
import { createEmbeddingProcessor } from './embedding-processor';
import type { EmbeddingJobData } from '@retailos/queue';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const asJob = (data: EmbeddingJobData): Job<EmbeddingJobData> => ({ data }) as Job<EmbeddingJobData>;

const FAKE_VALUES = Array.from({ length: 768 }, (_, i) => i / 768);
const fakeEmbed = async (_apiKey: string, _text: string) => ({ model: 'fake-embedding-v1', values: FAKE_VALUES });

/**
 * 009-18 — real Postgres proof of the embedding processor's own orchestration (build text from the
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
  });
});
