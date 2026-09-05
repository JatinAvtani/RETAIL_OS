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
  units,
  users,
  DocumentRepository,
  ProductRepository,
  SupplierProductRepository,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('productDetection.detectProducts', () => {
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

  const query = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({ method: 'GET', url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, cookies: { '__Host-session': cookie } });

  const issueSession = async (organizationId: string, role: 'OWNER', permissions: Permission[]): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `product-detection-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role, permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const setUpOrgAndStore = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Product Detection Test Org ${organizationId}`, slug: `product-detection-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Product Detection Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const extractedField = (value: string | null) => ({ value, confidence: value === null ? null : 0.9 });
  const extractedLine = (overrides: Partial<{ sku: string | null; description: string; quantity: string; unit: string | null; unitPrice: string }> = {}) => ({
    sku: extractedField(overrides.sku ?? null),
    description: extractedField(overrides.description ?? 'Flour T55 25kg'),
    quantity: extractedField(overrides.quantity ?? '2'),
    unit: extractedField(overrides.unit ?? null),
    unitPrice: extractedField(overrides.unitPrice ?? '18.00'),
    lineTotal: extractedField('36.00'),
  });

  /** Seeds a real APPROVED document with a real extraction carrying the given lines — the minimum a caller needs to have real, detection-eligible evidence. */
  const seedApprovedDocumentWithLines = async (
    organizationId: string,
    storeId: string,
    supplierName: string,
    lines: ReturnType<typeof extractedLine>[]
  ) => {
    const documentRepository = new DocumentRepository(db, organizationId);
    const documentId = generateId();
    await db.insert(documents).values({
      id: documentId,
      organizationId,
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      status: 'APPROVED',
      storageKey: `${organizationId}/probe-${documentId}.pdf`,
      contentHash: `probe-hash-${documentId}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: { supplier: extractedField(supplierName) },
      lines,
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });
    return documentId;
  };

  it('detects a real product candidate from two invoices with the same real supplierSku, with real evidence lines attached', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    await seedApprovedDocumentWithLines(organizationId, storeId, 'Nova Foods', [
      extractedLine({ sku: 'FLR-25', description: 'Flour T55 25kg' }),
    ]);
    await seedApprovedDocumentWithLines(organizationId, storeId, 'Nova Foods', [
      extractedLine({ sku: 'FLR-25', description: 'T55 FLOUR 25KG SACK' }),
    ]);

    const response = await query('productDetection.detectProducts', token, { storeId });
    expect(response.statusCode).toBe(200);
    const candidates = JSON.parse(response.body).result.data as Array<{ evidenceLines: unknown[]; proposedName: string }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.evidenceLines).toHaveLength(2);
  });

  it('excludes lines whose (supplier, sku) already has a CONFIRMED supplier_products mapping', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const supplierId = generateId();
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'Nova Foods' });
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    if (!eachUnit) throw new Error("product-detection.test.ts: seeded unit 'each' not found — migrations not applied?");
    const productRepository = new ProductRepository(db, organizationId);
    const product = await productRepository.create({
      id: generateId(),
      sku: `probe-flour-${generateId()}`,
      name: 'Flour T55',
      baseUnitId: eachUnit.id,
      type: 'INGREDIENT',
    });
    const supplierProductRepository = new SupplierProductRepository(db, organizationId);
    const created = await supplierProductRepository.create({
      id: generateId(),
      supplierId,
      productId: product.id,
      supplierSku: 'FLR-25',
    });
    await supplierProductRepository.confirm(created.id);

    await seedApprovedDocumentWithLines(organizationId, storeId, 'Nova Foods', [
      extractedLine({ sku: 'FLR-25', description: 'Flour T55 25kg' }),
    ]);

    const response = await query('productDetection.detectProducts', token, { storeId });
    const candidates = JSON.parse(response.body).result.data as unknown[];
    expect(candidates).toEqual([]);
  });

  it('does NOT read lines from a document still at REVIEW_REQUIRED — only approved evidence counts (I7)', async () => {
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
      storageKey: `${organizationId}/probe-${documentId}.pdf`,
      contentHash: `probe-hash-${documentId}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: { supplier: extractedField('Nova Foods') },
      lines: [extractedLine({ description: 'Flour T55 25kg' })],
      validation: { issues: [], canAutoApprove: false },
      overallConfidence: '0.5000',
    });

    const response = await query('productDetection.detectProducts', token, { storeId });
    const candidates = JSON.parse(response.body).result.data as unknown[];
    expect(candidates).toEqual([]);
  });

  it('detects a real product candidate with a proposed unit + pack size read from real description text', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    await seedApprovedDocumentWithLines(organizationId, storeId, 'Aurora Dairy', [
      extractedLine({ sku: 'BTR-1', description: 'Butter Unsalted 1kg', unit: 'kg' }),
    ]);

    const response = await query('productDetection.detectProducts', token, { storeId });
    const candidates = JSON.parse(response.body).result.data as Array<{ proposedUnit: string | null; proposedPackSize: string | null }>;
    expect(candidates[0]!.proposedUnit).toBe('kg');
    expect(candidates[0]!.proposedPackSize).toBe('1');
  });

  it('404s for a storeId from a different organization (cross-tenant, I4)', async () => {
    const seededA = await setUpOrgAndStore();
    const seededB = await setUpOrgAndStore();
    const tokenB = await issueSession(seededB.organizationId, 'OWNER', []);

    const response = await query('productDetection.detectProducts', tokenB, { storeId: seededA.storeId });
    expect(response.statusCode).toBe(404);
  });
});
