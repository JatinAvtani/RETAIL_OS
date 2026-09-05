import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  documentExtractions,
  documents,
  memberships,
  organizations,
  productVariants,
  products,
  stores,
  suppliers,
  supplierProducts,
  users,
  DocumentRepository,
  SupplierRepository,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('productDetection.confirmSupplier/confirmProduct', () => {
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
      await db.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
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

  const call = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/trpc/${path}`, cookies: { '__Host-session': cookie }, payload: input });

  const issueSession = async (organizationId: string, role: 'OWNER', permissions: Permission[]): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `product-detection-confirm-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role, permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const setUpOrgAndStore = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Confirm Detection Test Org ${organizationId}`, slug: `confirm-detection-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Confirm Detection Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const extractedField = (value: string | null) => ({ value, confidence: value === null ? null : 0.9 });

  const seedApprovedDocumentWithLine = async (organizationId: string, storeId: string, supplierName: string, sku: string) => {
    const documentRepository = new DocumentRepository(db, organizationId);
    const documentId = generateId();
    await db.insert(documents).values({
      id: documentId,
      organizationId,
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      status: 'APPROVED',
      storageKey: `${organizationId}/probe-confirm-${documentId}.pdf`,
      contentHash: `probe-confirm-hash-${documentId}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: { supplier: extractedField(supplierName) },
      lines: [
        {
          sku: extractedField(sku),
          description: extractedField('Flour T55 25kg'),
          quantity: extractedField('2'),
          unit: extractedField('kg'),
          unitPrice: extractedField('18.00'),
          lineTotal: extractedField('36.00'),
        },
      ],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });
    return documentId;
  };

  it('confirmSupplier creates a real suppliers row', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const response = await call('productDetection.confirmSupplier', token, { storeId, name: 'Nova Foods' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.name).toBe('Nova Foods');

    const supplierRepository = new SupplierRepository(db, organizationId);
    const found = await supplierRepository.findByExactName('Nova Foods');
    expect(found?.id).toBe(body.id);
  });

  it('confirmProduct creates a real product AND a confirmed supplier_products mapping for a real evidence line', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    await db.insert(suppliers).values({ id: generateId(), organizationId, name: 'Nova Foods' });
    const documentId = await seedApprovedDocumentWithLine(organizationId, storeId, 'Nova Foods', 'FLR-25');

    const response = await call('productDetection.confirmProduct', token, {
      storeId,
      sku: `flour-t55-${generateId()}`,
      name: 'Flour T55',
      baseUnitCode: 'kg',
      packSize: '25',
      evidenceLines: [{ documentId, lineIndex: 0 }],
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.product.name).toBe('Flour T55');
    expect(body.confirmedMappingCount).toBe(1);
    expect(body.skippedLines).toEqual([]);

    const [mapping] = await db.select().from(supplierProducts).where(eq(supplierProducts.supplierSku, 'FLR-25'));
    expect(mapping?.isConfirmed).toBe(true);
    expect(mapping?.productId).toBe(body.product.id);
    expect(mapping?.packSize).toBe('25.000000');
  });

  it('confirmProduct reports a line as skipped, never silently dropped, when its supplier is not confirmed yet', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const documentId = await seedApprovedDocumentWithLine(organizationId, storeId, 'Not Yet Confirmed Co', 'FLR-25');

    const response = await call('productDetection.confirmProduct', token, {
      storeId,
      sku: `flour-t55-${generateId()}`,
      name: 'Flour T55',
      baseUnitCode: 'kg',
      evidenceLines: [{ documentId, lineIndex: 0 }],
    });
    const body = JSON.parse(response.body).result.data;
    expect(body.confirmedMappingCount).toBe(0);
    expect(body.skippedLines).toHaveLength(1);
    expect(body.skippedLines[0].reason).toContain('Not Yet Confirmed Co');
    // The product itself IS still created (I7: an honest partial result, not an all-or-nothing block).
    expect(body.product.name).toBe('Flour T55');
  });

  it('confirmProduct is a real upsert — confirming the same (supplier, sku) twice updates, not duplicates', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    await db.insert(suppliers).values({ id: generateId(), organizationId, name: 'Nova Foods' });
    const documentId = await seedApprovedDocumentWithLine(organizationId, storeId, 'Nova Foods', 'FLR-25');

    await call('productDetection.confirmProduct', token, {
      storeId,
      sku: `flour-t55-a-${generateId()}`,
      name: 'Flour T55',
      baseUnitCode: 'kg',
      evidenceLines: [{ documentId, lineIndex: 0 }],
    });
    await call('productDetection.confirmProduct', token, {
      storeId,
      sku: `flour-t55-b-${generateId()}`,
      name: 'Flour T55 (renamed)',
      baseUnitCode: 'kg',
      evidenceLines: [{ documentId, lineIndex: 0 }],
    });

    const mappings = await db.select().from(supplierProducts).where(eq(supplierProducts.supplierSku, 'FLR-25'));
    expect(mappings).toHaveLength(1);
  });

  it('confirmSupplier 404s for a storeId from a different organization (cross-tenant, I4)', async () => {
    const seededA = await setUpOrgAndStore();
    const seededB = await setUpOrgAndStore();
    const tokenB = await issueSession(seededB.organizationId, 'OWNER', []);

    const response = await call('productDetection.confirmSupplier', tokenB, { storeId: seededA.storeId, name: 'Probe' });
    expect(response.statusCode).toBe(404);
  });
});
