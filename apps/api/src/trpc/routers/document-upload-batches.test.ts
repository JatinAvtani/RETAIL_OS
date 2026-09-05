import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, documents, documentUploadBatches, memberships, organizations, stores, users } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import { extractionQueue } from '../context';
import type { FastifyInstance } from 'fastify';

const REAL_PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF');

// Same reasoning as documents.test.ts's own suite — a trivial fake PDF classified deterministically
// as 'OTHER' with no live Gemini call, so this suite's assertions don't depend on model behavior.
delete process.env.GEMINI_API_KEY;

describe('documents — createUploadBatch/getBatchProgress', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sessionStore = new SessionStore(redis);
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      const orgDocuments = await db.select({ id: documents.id }).from(documents).where(eq(documents.organizationId, orgId));
      for (const doc of orgDocuments) {
        await (await extractionQueue.getJob(doc.id))?.remove();
      }
      // Child-then-parent: documents (references document_upload_batches AND stores) before the
      // batch and before stores; stores/memberships before organizations.
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      await db.delete(documentUploadBatches).where(eq(documentUploadBatches.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(memberships).where(eq(memberships.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    for (const userId of createdUserIds) {
      await db.delete(users).where(eq(users.id, userId));
    }
    createdOrgIds.length = 0;
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const call = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/trpc/${path}`, cookies: { '__Host-session': cookie }, payload: input });

  const query = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({ method: 'GET', url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, cookies: { '__Host-session': cookie } });

  const issueSession = async (organizationId: string, role: 'OWNER' | 'STAFF', permissions: Permission[]): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `upload-batches-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role, permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const setUpOrgAndStore = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Upload Batch Test Org ${organizationId}`, slug: `upload-batch-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: `Upload Batch Test Store ${storeId}`, timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const uploadOneRealDocument = async (token: string, storeId: string, uploadBatchId?: string) => {
    const requestResponse = await call('documents.requestUpload', token, { storeId });
    const { key, uploadUrl } = JSON.parse(requestResponse.body).result.data as { key: string; uploadUrl: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: REAL_PDF_BYTES });
    return call('documents.confirmUpload', token, { storeId, key, ...(uploadBatchId ? { uploadBatchId } : {}) });
  };

  it('createUploadBatch writes a real row a subsequent getBatchProgress reads back, uploadedCount 0 with no documents yet', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const create = await call('documents.createUploadBatch', token, { storeId, expectedCount: 3 });
    expect(create.statusCode).toBe(200);
    const { id: batchId, expectedCount } = JSON.parse(create.body).result.data;
    expect(expectedCount).toBe(3);

    const progress = await query('documents.getBatchProgress', token, { batchId });
    const progressBody = JSON.parse(progress.body).result.data;
    expect(progressBody.expectedCount).toBe(3);
    expect(progressBody.uploadedCount).toBe(0);
    expect(progressBody.countsByStatus).toEqual({});
  });

  it('a real confirmUpload attached to a batch is reflected in getBatchProgress', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const create = await call('documents.createUploadBatch', token, { storeId, expectedCount: 2 });
    const { id: batchId } = JSON.parse(create.body).result.data;

    const confirm = await uploadOneRealDocument(token, storeId, batchId);
    expect(confirm.statusCode).toBe(200);

    const progress = await query('documents.getBatchProgress', token, { batchId });
    const progressBody = JSON.parse(progress.body).result.data;
    expect(progressBody.uploadedCount).toBe(1);
    expect(progressBody.countsByStatus.UPLOADED).toBe(1);
  });

  it('confirmUpload with a batchId from a different store in the SAME org is rejected', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const otherStoreId = generateId();
    await db.insert(stores).values({ id: otherStoreId, organizationId, name: 'Other Store', timezone: 'America/New_York' });
    const token = await issueSession(organizationId, 'OWNER', []);

    const create = await call('documents.createUploadBatch', token, { storeId: otherStoreId, expectedCount: 1 });
    const { id: batchId } = JSON.parse(create.body).result.data;

    const confirm = await uploadOneRealDocument(token, storeId, batchId);
    expect(confirm.statusCode).toBe(404);
  });

  it('getBatchProgress 404s for a nonexistent batchId', async () => {
    const { organizationId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const response = await query('documents.getBatchProgress', token, { batchId: generateId() });
    expect(response.statusCode).toBe(404);
  });

  it('createUploadBatch 404s for a storeId from a different organization (cross-tenant, I4)', async () => {
    const seededA = await setUpOrgAndStore();
    const seededB = await setUpOrgAndStore();
    const tokenB = await issueSession(seededB.organizationId, 'OWNER', []);

    const response = await call('documents.createUploadBatch', tokenB, { storeId: seededA.storeId, expectedCount: 1 });
    expect(response.statusCode).toBe(404);
  });
});
