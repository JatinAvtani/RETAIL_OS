import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { documents, documentUploadBatches } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { DocumentUploadBatchRepository } from './document-upload-batch-repository';
import { DocumentRepository } from './document-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('DocumentUploadBatchRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let fixture: TwoTenantFixture;

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    // Child-then-parent: documents (references document_upload_batches) before the batch itself.
    await adminDb.delete(documents).where(eq(documents.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(documents).where(eq(documents.organizationId, fixture.tenantB.organizationId));
    await adminDb.delete(documentUploadBatches).where(eq(documentUploadBatches.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(documentUploadBatches).where(eq(documentUploadBatches.organizationId, fixture.tenantB.organizationId));
    await client.end();
    await fixture.cleanup();
  });

  it('create writes a real row, findById reads it back', async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);

    const db = createScopedDb(client);
    const repo = new DocumentUploadBatchRepository(db, fixture.tenantA.organizationId);

    const { id } = await repo.create({ storeId: fixture.tenantA.storeId, expectedCount: 5 });
    const found = await repo.findById(id);
    expect(found?.expectedCount).toBe(5);
    expect(found?.storeId).toBe(fixture.tenantA.storeId);
  });

  it('getProgress derives real counts from member documents\' actual statuses, grouped', async () => {
    const db = createScopedDb(client);
    const batchRepo = new DocumentUploadBatchRepository(db, fixture.tenantA.organizationId);
    const documentRepo = new DocumentRepository(db, fixture.tenantA.organizationId);

    const { id: batchId } = await batchRepo.create({ storeId: fixture.tenantA.storeId, expectedCount: 3 });

    await documentRepo.create({
      storeId: fixture.tenantA.storeId,
      source: 'UPLOAD',
      storageKey: `probe-${generateId()}`,
      contentHash: generateId(),
      mimeType: 'application/pdf',
      sizeBytes: 100,
      uploadBatchId: batchId,
    });
    const second = await documentRepo.create({
      storeId: fixture.tenantA.storeId,
      source: 'UPLOAD',
      storageKey: `probe-${generateId()}`,
      contentHash: generateId(),
      mimeType: 'application/pdf',
      sizeBytes: 100,
      uploadBatchId: batchId,
    });
    await documentRepo.updateStatus(second.id, 'REVIEW_REQUIRED');

    const progress = await batchRepo.getProgress(batchId);
    expect(progress?.expectedCount).toBe(3);
    expect(progress?.uploadedCount).toBe(2);
    expect(progress?.countsByStatus.UPLOADED).toBe(1);
    expect(progress?.countsByStatus.REVIEW_REQUIRED).toBe(1);
  });

  it('getProgress returns uploadedCount 0 for a batch with no documents yet — never a fabricated non-zero', async () => {
    const db = createScopedDb(client);
    const batchRepo = new DocumentUploadBatchRepository(db, fixture.tenantA.organizationId);

    const { id: batchId } = await batchRepo.create({ storeId: fixture.tenantA.storeId, expectedCount: 10 });
    const progress = await batchRepo.getProgress(batchId);
    expect(progress?.uploadedCount).toBe(0);
    expect(progress?.countsByStatus).toEqual({});
  });

  it('getProgress returns null for a nonexistent batch', async () => {
    const db = createScopedDb(client);
    const batchRepo = new DocumentUploadBatchRepository(db, fixture.tenantA.organizationId);
    const progress = await batchRepo.getProgress(generateId());
    expect(progress).toBeNull();
  });

  it('tenant isolation: tenant B cannot find tenant A\'s real batch by id', async () => {
    const dbA = createScopedDb(client);
    const batchRepoA = new DocumentUploadBatchRepository(dbA, fixture.tenantA.organizationId);
    const { id: batchId } = await batchRepoA.create({ storeId: fixture.tenantA.storeId, expectedCount: 7 });

    const dbB = createScopedDb(client);
    const batchRepoB = new DocumentUploadBatchRepository(dbB, fixture.tenantB.organizationId);
    const found = await batchRepoB.findById(batchId);
    expect(found).toBeNull();
    const progress = await batchRepoB.getProgress(batchId);
    expect(progress).toBeNull();
  });
});
