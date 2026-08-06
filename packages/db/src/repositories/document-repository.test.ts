import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { documentExtractions, documentLinks, documents, extractionCorrections, organizations, stores, users } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { DocumentRepository } from './document-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('DocumentRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let userId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Document Repo Test Org',
      slug: `document-repo-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    userId = generateId();
    await adminDb.insert(users).values({ id: userId, email: `document-repo-test-${userId}@example.test` });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    // FK order: extraction_corrections -> document_extractions -> document_links -> documents.
    await adminDb.delete(extractionCorrections).where(eq(extractionCorrections.organizationId, organizationId));
    await adminDb.delete(documentExtractions).where(eq(documentExtractions.organizationId, organizationId));
    await adminDb.delete(documentLinks).where(eq(documentLinks.organizationId, organizationId));
    await adminDb.delete(documents).where(eq(documents.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(users).where(eq(users.id, userId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('create records a new document and findById returns it', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/invoice-1.pdf`,
      contentHash: 'hash-1',
      mimeType: 'application/pdf',
      sizeBytes: 12345,
      uploadedByUserId: userId,
    });

    const row = await repo.findById(created.id);
    expect(row?.status).toBe('UPLOADED');
    expect(row?.type).toBe('INVOICE');
    expect(row?.contentHash).toBe('hash-1');
    expect(row?.version).toBe(1);
  });

  it('the exact same content hash can be uploaded twice — duplicate detection is a validation-gate decision, not a DB constraint', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/dup-1.pdf`,
      contentHash: 'same-hash',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/dup-2.pdf`,
      contentHash: 'same-hash',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    const matches = await repo.findByContentHash('same-hash');
    expect(matches).toHaveLength(2);
  });

  it('updateStatus moves a document through the pipeline', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/status.pdf`,
      contentHash: 'hash-status',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    const updated = await repo.updateStatus(created.id, 'REVIEW_REQUIRED');
    expect(updated?.status).toBe('REVIEW_REQUIRED');

    const [inReview] = await repo.listByStatus('REVIEW_REQUIRED');
    expect(inReview?.id).toBe(created.id);
  });

  it('recordExtraction stores a real extraction row, and getLatestExtraction returns the most recent one', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/extract.pdf`,
      contentHash: 'hash-extract',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    const first = await repo.recordExtraction({
      documentId: created.id,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: 'v1',
      fields: { supplier: { value: 'Acme', confidence: 0.9 } },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });

    // A real re-extraction (a better model) adds a new row rather than overwriting the first.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await repo.recordExtraction({
      documentId: created.id,
      provider: 'gemini',
      modelVersion: 'flash-lite-v2',
      promptVersion: 'v2',
      fields: { supplier: { value: 'Acme Corp', confidence: 0.95 } },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9500',
    });

    expect(first.id).not.toBe(second.id);

    const latest = await repo.getLatestExtraction(created.id);
    expect(latest?.id).toBe(second.id);
    expect(latest?.modelVersion).toBe('flash-lite-v2');
  });

  it('recordCorrection stores a human correction against an extraction', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/correction.pdf`,
      contentHash: 'hash-correction',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    const extraction = await repo.recordExtraction({
      documentId: created.id,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: 'v1',
      fields: {},
      lines: [{ description: 'Flour', qty: 10, unitPrice: 1.05, total: 10.5, confidence: 0.4 }],
      validation: { issues: [], canAutoApprove: false },
    });

    const correction = await repo.recordCorrection({
      extractionId: extraction.id,
      fieldPath: 'lines[0].unitPrice',
      originalValue: 1.05,
      correctedValue: 10.5,
      correctedByUserId: userId,
    });

    expect(correction.id).toBeTruthy();
  });

  it('addLink records provenance, and a duplicate (documentId, entityType, entityId, relationship) is a no-op', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/link.pdf`,
      contentHash: 'hash-link',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    const fakeSupplierPriceId = generateId();

    const first = await repo.addLink({
      documentId: created.id,
      entityType: 'supplier_price',
      entityId: fakeSupplierPriceId,
      relationship: 'PRICE_SOURCE',
    });
    expect('id' in first).toBe(true);

    const second = await repo.addLink({
      documentId: created.id,
      entityType: 'supplier_price',
      entityId: fakeSupplierPriceId,
      relationship: 'PRICE_SOURCE',
    });
    expect('status' in second && second.status).toBe('duplicate');

    const links = await repo.findLinksForDocument(created.id);
    expect(links).toHaveLength(1);
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new DocumentRepository(createScopedDb(client), '')).toThrow();
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(documentExtractions).where(eq(documentExtractions.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(documentExtractions).where(eq(documentExtractions.organizationId, fixture.tenantB.organizationId));
      await adminDb.delete(documents).where(eq(documents.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(documents).where(eq(documents.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A document by id', async () => {
      const repoA = new DocumentRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.create({
        storeId: fixture.tenantA.storeId,
        type: 'INVOICE',
        source: 'UPLOAD',
        storageKey: `${fixture.tenantA.organizationId}/cross-tenant.pdf`,
        contentHash: 'cross-tenant-hash',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      });

      const repoB = new DocumentRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const seenByB = await repoB.findById(created.id);
      expect(seenByB).toBeNull();
    });

    it('tenant B cannot see tenant A document_extractions via getLatestExtraction', async () => {
      const repoA = new DocumentRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.create({
        storeId: fixture.tenantA.storeId,
        type: 'INVOICE',
        source: 'UPLOAD',
        storageKey: `${fixture.tenantA.organizationId}/cross-tenant-extraction.pdf`,
        contentHash: 'cross-tenant-extraction-hash',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      });
      await repoA.recordExtraction({
        documentId: created.id,
        provider: 'gemini',
        modelVersion: 'flash-lite-v1',
        promptVersion: 'v1',
        fields: {},
        lines: [],
        validation: { issues: [], canAutoApprove: true },
      });

      const repoB = new DocumentRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const seenByB = await repoB.getLatestExtraction(created.id);
      expect(seenByB).toBeNull();
    });

    it('raw insert attempting to claim another org id is rejected by RLS, independent of the repository layer', async () => {
      const scopedDb = createScopedDb(client);
      await expect(
        scopedDb.transaction(async (tx) => {
          await tx.execute(`SET LOCAL app.current_org_id = '${fixture.tenantB.organizationId}'`);
          await tx.insert(documents).values({
            id: generateId(),
            organizationId: fixture.tenantA.organizationId, // claiming tenant A while set as tenant B
            storeId: fixture.tenantA.storeId,
            type: 'INVOICE',
            source: 'UPLOAD',
            storageKey: 'attack.pdf',
            contentHash: 'attack-hash',
            mimeType: 'application/pdf',
            sizeBytes: 1,
          });
        })
      ).rejects.toThrow();
    });
  });
});
