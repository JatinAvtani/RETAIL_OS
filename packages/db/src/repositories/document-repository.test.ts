import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { auditLogs, documentExtractions, documentLinks, documents, extractionCorrections, organizations, outboxEvents, stores, users } from '../schema/index';
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
    // outbox_events/audit_logs reference organizations, not documents directly (aggregateId/entityId
    // are plain uuids, not real FKs — same polymorphic-reference convention document_links uses), so
    // order relative to documents doesn't matter, but they must still be cleaned up per test since
    // earlier work's approve/reject write real rows into both.
    await adminDb.delete(extractionCorrections).where(eq(extractionCorrections.organizationId, organizationId));
    await adminDb.delete(documentExtractions).where(eq(documentExtractions.organizationId, organizationId));
    await adminDb.delete(documentLinks).where(eq(documentLinks.organizationId, organizationId));
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
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

  it('search filters by status', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const uploaded = await repo.create({ storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/s1.pdf`, contentHash: 'hash-search-1', mimeType: 'application/pdf', sizeBytes: 1 });
    const reviewing = await repo.create({ storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/s2.pdf`, contentHash: 'hash-search-2', mimeType: 'application/pdf', sizeBytes: 1 });
    await repo.updateStatus(reviewing.id, 'REVIEW_REQUIRED');

    const results = await repo.search(storeId, { status: 'REVIEW_REQUIRED' });
    expect(results.map((r) => r.id)).toEqual([reviewing.id]);
    expect(results.some((r) => r.id === uploaded.id)).toBe(false);
  });

  it('search filters by type', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const invoice = await repo.create({ storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/t1.pdf`, contentHash: 'hash-search-type-1', mimeType: 'application/pdf', sizeBytes: 1 });
    await repo.create({ storeId, type: 'QUOTE', source: 'UPLOAD', storageKey: `${organizationId}/t2.pdf`, contentHash: 'hash-search-type-2', mimeType: 'application/pdf', sizeBytes: 1 });

    const results = await repo.search(storeId, { type: 'INVOICE' });
    expect(results.map((r) => r.id)).toEqual([invoice.id]);
  });

  it('search with a text query matches the latest extraction\'s supplier name, case-insensitively', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const matching = await repo.create({ storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/q1.pdf`, contentHash: 'hash-search-q1', mimeType: 'application/pdf', sizeBytes: 1 });
    const nonMatching = await repo.create({ storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/q2.pdf`, contentHash: 'hash-search-q2', mimeType: 'application/pdf', sizeBytes: 1 });
    await repo.recordExtraction({
      documentId: matching.id,
      provider: 'gemini',
      modelVersion: 'v1',
      promptVersion: '1',
      fields: { supplier: { value: 'Coastal Meats & Poultry', confidence: 0.9 } },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
    });
    await repo.recordExtraction({
      documentId: nonMatching.id,
      provider: 'gemini',
      modelVersion: 'v1',
      promptVersion: '1',
      fields: { supplier: { value: 'Unrelated Supplier Co', confidence: 0.9 } },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
    });

    const results = await repo.search(storeId, { query: 'coastal' });
    expect(results.map((r) => r.id)).toEqual([matching.id]);
  });

  it('search with a text query matches the document number too', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const matching = await repo.create({ storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/q3.pdf`, contentHash: 'hash-search-q3', mimeType: 'application/pdf', sizeBytes: 1 });
    await repo.recordExtraction({
      documentId: matching.id,
      provider: 'gemini',
      modelVersion: 'v1',
      promptVersion: '1',
      fields: { supplier: { value: null, confidence: null }, documentNumber: { value: 'INV-99887', confidence: 0.9 } },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
    });

    const results = await repo.search(storeId, { query: '99887' });
    expect(results.map((r) => r.id)).toEqual([matching.id]);
  });

  it('search with a text query excludes a document with no extraction at all — no data to search is not a match (I7)', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    await repo.create({ storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/q4.pdf`, contentHash: 'hash-search-q4', mimeType: 'application/pdf', sizeBytes: 1 });

    const results = await repo.search(storeId, { query: 'anything' });
    expect(results).toHaveLength(0);
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

  it('approve moves a REVIEW_REQUIRED document to APPROVED and writes a real outbox event + audit log entry, both inside the same write', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/approve.pdf`,
      contentHash: 'hash-approve',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await repo.updateStatus(created.id, 'REVIEW_REQUIRED');

    const approved = await repo.approve(created.id, userId);
    expect(approved?.status).toBe('APPROVED');

    const adminDb = drizzle(adminClient, { schema });
    const [outboxRow] = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, created.id));
    expect(outboxRow?.eventType).toBe('document.approved');
    expect(outboxRow?.payload).toMatchObject({ documentId: created.id, previousStatus: 'REVIEW_REQUIRED' });

    const [auditRow] = await adminDb.select().from(auditLogs).where(eq(auditLogs.entityId, created.id));
    expect(auditRow?.action).toBe('document.approved');
    expect(auditRow?.actorUserId).toBe(userId);
  });

  it('approve also accepts an AUTO_APPROVED document — an auto-approval is "still reviewable", a human can override it', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/auto-approve.pdf`,
      contentHash: 'hash-auto-approve',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await repo.updateStatus(created.id, 'AUTO_APPROVED');

    const approved = await repo.approve(created.id, userId);
    expect(approved?.status).toBe('APPROVED');
  });

  it('reject moves a REVIEW_REQUIRED document to REJECTED, records the reason, and never posts (rejected documents stay out of )', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/reject.pdf`,
      contentHash: 'hash-reject',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await repo.updateStatus(created.id, 'REVIEW_REQUIRED');

    const rejected = await repo.reject(created.id, userId, 'Wrong document — this is a delivery note, not an invoice.');
    expect(rejected?.status).toBe('REJECTED');

    const adminDb = drizzle(adminClient, { schema });
    const [outboxRow] = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, created.id));
    expect(outboxRow?.eventType).toBe('document.rejected');
    expect(outboxRow?.payload).toMatchObject({ reason: 'Wrong document — this is a delivery note, not an invoice.' });
  });

  it('approve returns null (never throws) for a document that is not in a reviewable state, e.g. still UPLOADED', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/not-reviewable.pdf`,
      contentHash: 'hash-not-reviewable',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    const result = await repo.approve(created.id, userId);
    expect(result).toBeNull();

    const stillUploaded = await repo.findById(created.id);
    expect(stillUploaded?.status).toBe('UPLOADED');
  });

  it('approve returns null for a document that does not exist', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const result = await repo.approve(generateId(), userId);
    expect(result).toBeNull();
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

  it('findBySupplierAndDocumentNumber finds another document sharing the same extracted supplier + documentNumber, case-insensitively', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const first = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/dup-number-1.pdf`,
      contentHash: 'hash-dup-number-1',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await repo.recordExtraction({
      documentId: first.id,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: 'v1',
      fields: { supplier: { value: 'Acme Foods', confidence: 0.9 }, documentNumber: { value: 'INV-999', confidence: 0.9 } },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
    });

    const second = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/dup-number-2.pdf`,
      contentHash: 'hash-dup-number-2',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    const matches = await repo.findBySupplierAndDocumentNumber(second.id, 'acme foods', 'inv-999');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(first.id);
  });

  it('findBySupplierAndDocumentNumber excludes the document itself', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/self-exclude.pdf`,
      contentHash: 'hash-self-exclude',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await repo.recordExtraction({
      documentId: created.id,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: 'v1',
      fields: { supplier: { value: 'Acme Foods', confidence: 0.9 }, documentNumber: { value: 'INV-SELF', confidence: 0.9 } },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
    });

    const matches = await repo.findBySupplierAndDocumentNumber(created.id, 'Acme Foods', 'INV-SELF');
    expect(matches).toHaveLength(0);
  });

  it('findBySupplierAndDocumentNumber returns nothing when no other document has a matching pair', async () => {
    const repo = new DocumentRepository(createScopedDb(client), organizationId);
    const created = await repo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/no-match.pdf`,
      contentHash: 'hash-no-match',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    const matches = await repo.findBySupplierAndDocumentNumber(created.id, 'Nobody', 'NONE');
    expect(matches).toHaveLength(0);
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

    it('tenant B cannot approve tenant A document — approve returns null, no status change, no outbox/audit rows written', async () => {
      const repoA = new DocumentRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.create({
        storeId: fixture.tenantA.storeId,
        type: 'INVOICE',
        source: 'UPLOAD',
        storageKey: `${fixture.tenantA.organizationId}/cross-tenant-approve.pdf`,
        contentHash: 'cross-tenant-approve-hash',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      });
      await repoA.updateStatus(created.id, 'REVIEW_REQUIRED');

      const repoB = new DocumentRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const result = await repoB.approve(created.id, fixture.tenantB.userId);
      expect(result).toBeNull();

      const stillReviewRequired = await repoA.findById(created.id);
      expect(stillReviewRequired?.status).toBe('REVIEW_REQUIRED');

      const adminDb = drizzle(adminClient, { schema });
      const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, created.id));
      expect(outboxRows).toHaveLength(0);
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
