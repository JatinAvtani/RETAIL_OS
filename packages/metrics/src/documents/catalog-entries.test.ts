import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId } from '@retailos/domain';
import {
  createDb,
  documentExtractions,
  documents,
  organizations,
  stores,
  withTenantContext,
  DocumentRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that `documents_pending_review`, `documents_pending_review_oldest_age_days`,
 * and `extraction_auto_approval_rate` compute correctly through `executeMetric`.
 * `extraction_auto_approval_rate` was already a pure, tested function — this test proves
 * the real fetch-then-compute wiring, not the pure math (already covered by
 * `extraction-accuracy.test.ts`).
 */
describe('registered document health metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      await adminDb.delete(documents).where(eq(documents.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await adminClient.end();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Document Metrics Test Org ${organizationId}`,
      slug: `document-metrics-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' })
      )
    );
    return { organizationId, storeId };
  };

  const auth = (permissions: readonly string[] = ['documents:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });

  it('documents_pending_review counts a real document at REVIEW_REQUIRED', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const documentRepository = new DocumentRepository(db, organizationId);
    const { id: documentId } = await documentRepository.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/pending-1.pdf`,
      contentHash: 'hash-pending-1',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await documentRepository.updateStatus(documentId, 'REVIEW_REQUIRED');

    const result = await executeMetric('documents_pending_review', { storeId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('1');
  });

  it('documents_pending_review excludes a document already APPROVED', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const documentRepository = new DocumentRepository(db, organizationId);
    const { id: documentId } = await documentRepository.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/approved-1.pdf`,
      contentHash: 'hash-approved-1',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await documentRepository.updateStatus(documentId, 'REVIEW_REQUIRED');
    await documentRepository.updateStatus(documentId, 'APPROVED');

    const result = await executeMetric('documents_pending_review', { storeId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('0');
  });

  it('documents_pending_review_oldest_age_days is unknown with no documents pending review', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const result = await executeMetric(
      'documents_pending_review_oldest_age_days',
      { storeId },
      auth(),
      plainCtx(organizationId)
    );
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('documents_pending_review_oldest_age_days reports a real near-zero age for a document that just entered REVIEW_REQUIRED', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const documentRepository = new DocumentRepository(db, organizationId);
    const { id: documentId } = await documentRepository.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/age-1.pdf`,
      contentHash: 'hash-age-1',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await documentRepository.updateStatus(documentId, 'REVIEW_REQUIRED');

    const result = await executeMetric(
      'documents_pending_review_oldest_age_days',
      { storeId },
      auth(),
      plainCtx(organizationId)
    );
    expect(result.value).not.toBe('unknown');
    expect(Number(result.value)).toBeGreaterThanOrEqual(0);
    expect(Number(result.value)).toBeLessThan(0.01);
  });

  it('extraction_auto_approval_rate is unknown with no extractions at all', async () => {
    const { organizationId } = await setUpOrg();
    const result = await executeMetric('extraction_auto_approval_rate', {}, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('extraction_auto_approval_rate computes a real percentage from a mix of real extraction outcomes', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const documentRepository = new DocumentRepository(db, organizationId);

    const seedExtraction = async (canAutoApprove: boolean, overallConfidence: string, fieldConfidence: number) => {
      const { id: documentId } = await documentRepository.create({
        storeId,
        type: 'INVOICE',
        source: 'UPLOAD',
        storageKey: `${organizationId}/rate-${generateId()}.pdf`,
        contentHash: `hash-rate-${generateId()}`,
        mimeType: 'application/pdf',
        sizeBytes: 1,
      });
      await documentRepository.recordExtraction({
        documentId,
        provider: 'gemini',
        modelVersion: 'test',
        promptVersion: 'test',
        fields: { supplier: { value: 'Rate Test Supplier', confidence: fieldConfidence } },
        lines: [],
        validation: { issues: [], canAutoApprove },
        overallConfidence,
      });
    };

    // 2 real auto-approved (gate clean, high confidence), 1 real gate-failed (never auto-approved
    // regardless of confidence) -> 2/3.
    await seedExtraction(true, '0.9000', 0.9);
    await seedExtraction(true, '0.9000', 0.9);
    await seedExtraction(false, '0.9000', 0.9);

    const result = await executeMetric('extraction_auto_approval_rate', {}, auth(), plainCtx(organizationId));
    expect(result.value).toBe('66.67');
  });

  it('executeMetric refuses a caller without documents:read for a document health metric', async () => {
    const { organizationId, storeId } = await setUpOrg();
    await expect(
      executeMetric('documents_pending_review', { storeId }, auth([]), plainCtx(organizationId))
    ).rejects.toThrow(/documents:read/);
  });
});
