import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  documentExtractions,
  documents,
  memberships,
  organizations,
  stores,
  suppliers,
  users,
  DocumentRepository,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('productDetection.detectSuppliers', () => {
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
      await db.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));
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

  const query = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({ method: 'GET', url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, cookies: { '__Host-session': cookie } });

  const issueSession = async (organizationId: string, role: 'OWNER', permissions: Permission[]): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `product-detection-suppliers-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role, permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const setUpOrgAndStore = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Supplier Detection Test Org ${organizationId}`, slug: `supplier-detection-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Supplier Detection Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const extractedField = (value: string | null) => ({ value, confidence: value === null ? null : 0.9 });

  /** Seeds a real APPROVED document with a real extraction naming the given supplier — the minimum evidence detectSuppliers needs. */
  const seedApprovedDocumentForSupplier = async (organizationId: string, storeId: string, supplierName: string) => {
    const documentRepository = new DocumentRepository(db, organizationId);
    const documentId = generateId();
    await db.insert(documents).values({
      id: documentId,
      organizationId,
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      status: 'APPROVED',
      storageKey: `${organizationId}/probe-supplier-${documentId}.pdf`,
      contentHash: `probe-supplier-hash-${documentId}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: { supplier: extractedField(supplierName) },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });
    return documentId;
  };

  it('detects a real supplier candidate from two invoices naming similar supplier text, with real evidence document ids', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const docA = await seedApprovedDocumentForSupplier(organizationId, storeId, 'Nova Foods');
    const docB = await seedApprovedDocumentForSupplier(organizationId, storeId, 'Nova Foods Ltd');

    const response = await query('productDetection.detectSuppliers', token, { storeId });
    expect(response.statusCode).toBe(200);
    const candidates = JSON.parse(response.body).result.data as Array<{ evidenceDocumentIds: string[]; proposedName: string }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.evidenceDocumentIds.sort()).toEqual([docA, docB].sort());
  });

  it('excludes a supplier name that already has a real suppliers row, even mentioned repeatedly', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    await db.insert(suppliers).values({ id: generateId(), organizationId, name: 'Nova Foods' });
    await seedApprovedDocumentForSupplier(organizationId, storeId, 'Nova Foods');
    await seedApprovedDocumentForSupplier(organizationId, storeId, 'Nova Foods');

    const response = await query('productDetection.detectSuppliers', token, { storeId });
    const candidates = JSON.parse(response.body).result.data as unknown[];
    expect(candidates).toEqual([]);
  });

  it('does NOT read from a document still at REVIEW_REQUIRED — only approved evidence counts (I7)', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const documentRepository = new DocumentRepository(db, organizationId);
    const documentId = generateId();
    await db.insert(documents).values({
      id: documentId,
      organizationId,
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      status: 'REVIEW_REQUIRED',
      storageKey: `${organizationId}/probe-supplier-${documentId}.pdf`,
      contentHash: `probe-supplier-hash-${documentId}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: { supplier: extractedField('Nova Foods') },
      lines: [],
      validation: { issues: [], canAutoApprove: false },
      overallConfidence: '0.5000',
    });

    const response = await query('productDetection.detectSuppliers', token, { storeId });
    const candidates = JSON.parse(response.body).result.data as unknown[];
    expect(candidates).toEqual([]);
  });

  it('404s for a storeId from a different organization (cross-tenant, I4)', async () => {
    const seededA = await setUpOrgAndStore();
    const seededB = await setUpOrgAndStore();
    const tokenB = await issueSession(seededB.organizationId, 'OWNER', []);

    const response = await query('productDetection.detectSuppliers', tokenB, { storeId: seededA.storeId });
    expect(response.statusCode).toBe(404);
  });
});
