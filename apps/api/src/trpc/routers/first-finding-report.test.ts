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
  supplierPrices,
  supplierProducts,
  supplierPerformanceEvents,
  units,
  users,
  DocumentRepository,
  ProductRepository,
  SupplierPerformanceEventRepository,
  SupplierPriceRepository,
  SupplierProductRepository,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('firstFindingReport.generate', () => {
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
      await db.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, orgId));
      await db.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      // supplier_prices has NO organization_id column of its own (see SupplierPriceRepository's
      // own doc comment — RLS is enforced via a subquery through supplier_products instead), so it
      // must be deleted by real supplierProductId, scoped through this org's own supplier_products
      // rows, BEFORE those rows are deleted below.
      const orgSupplierProducts = await db.select({ id: supplierProducts.id }).from(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      for (const sp of orgSupplierProducts) {
        await db.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, sp.id));
      }
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
    await db.insert(users).values({ id: userId, email: `first-finding-report-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role, permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const setUpOrgAndStore = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `First Finding Test Org ${organizationId}`, slug: `first-finding-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'First Finding Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const field = (value: string | null) => ({ value, confidence: value === null ? null : 0.9 });

  const seedApprovedDocument = async (
    organizationId: string,
    storeId: string,
    input: { supplierName: string; documentNumber: string; total: string; contentHash: string }
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
      storageKey: `${organizationId}/probe-report-${documentId}.pdf`,
      contentHash: input.contentHash,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: {
        supplier: field(input.supplierName),
        documentNumber: field(input.documentNumber),
        total: field(input.total),
      },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });
    return documentId;
  };

  it('cites a real price-change finding derived from a real PRICE_CHANGE event', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const supplierId = generateId();
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'Nova Foods' });
    const productRepository = new ProductRepository(db, organizationId);
    const product = await productRepository.create({
      id: generateId(),
      sku: `flour-${generateId()}`,
      name: 'Flour T55',
      baseUnitId: eachUnit!.id,
      type: 'INGREDIENT',
    });
    const documentId = await seedApprovedDocument(organizationId, storeId, {
      supplierName: 'Nova Foods',
      documentNumber: 'INV-1',
      total: '224.00',
      contentHash: `hash-${generateId()}`,
    });

    await db.transaction((tx) =>
      SupplierPerformanceEventRepository.recordInTx(tx, organizationId, {
        organizationId,
        supplierId,
        eventType: 'PRICE_CHANGE',
        productId: product.id,
        documentId,
        expectedValue: '10.00',
        actualValue: '11.20',
        variance: '1430.00',
        occurredAt: new Date(),
      })
    );

    const response = await query('firstFindingReport.generate', token, { storeId, days: 90 });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.supplierCount).toBe(1);
    const priceChangeFinding = body.findings.find((f: { kind: string }) => f.kind === 'PRICE_CHANGE');
    expect(priceChangeFinding).toBeDefined();
    expect(priceChangeFinding.percentChange).toBe('12.0');
    expect(priceChangeFinding.annualizedImpact).toBe('1430.000000');
    expect(priceChangeFinding.evidenceDocumentIds).toEqual([documentId]);
  });

  it('cites a real duplicate-invoice finding from two documents sharing a real content hash', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const sharedHash = `hash-${generateId()}`;
    const docA = await seedApprovedDocument(organizationId, storeId, {
      supplierName: 'Nova Foods',
      documentNumber: '8891',
      total: '340.00',
      contentHash: sharedHash,
    });
    const docB = await seedApprovedDocument(organizationId, storeId, {
      supplierName: 'Nova Foods',
      documentNumber: '8891',
      total: '340.00',
      contentHash: sharedHash,
    });

    const response = await query('firstFindingReport.generate', token, { storeId, days: 90 });
    const body = JSON.parse(response.body).result.data;
    const duplicateFinding = body.findings.find((f: { kind: string }) => f.kind === 'DUPLICATE_INVOICE');
    expect(duplicateFinding).toBeDefined();
    expect(duplicateFinding.total).toBe('340.00');
    expect(duplicateFinding.evidenceDocumentIds.sort()).toEqual([docA, docB].sort());
  });

  it('cites a real cross-supplier price finding for confirmed quotes with the SAME pack size', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productRepository = new ProductRepository(db, organizationId);
    const product = await productRepository.create({
      id: generateId(),
      sku: `butter-${generateId()}`,
      name: 'Butter Unsalted',
      baseUnitId: eachUnit!.id,
      type: 'INGREDIENT',
    });

    const novaSupplierId = generateId();
    const auroraSupplierId = generateId();
    await db.insert(suppliers).values([
      { id: novaSupplierId, organizationId, name: 'Nova Foods' },
      { id: auroraSupplierId, organizationId, name: 'Aurora Dairy' },
    ]);

    const docNova = await seedApprovedDocument(organizationId, storeId, {
      supplierName: 'Nova Foods',
      documentNumber: 'N-1',
      total: '5.00',
      contentHash: `hash-${generateId()}`,
    });
    const docAurora = await seedApprovedDocument(organizationId, storeId, {
      supplierName: 'Aurora Dairy',
      documentNumber: 'A-1',
      total: '5.90',
      contentHash: `hash-${generateId()}`,
    });

    const supplierProductRepository = new SupplierProductRepository(db, organizationId);
    const supplierPriceRepository = new SupplierPriceRepository(db, organizationId);

    const novaMapping = await supplierProductRepository.create({
      id: generateId(),
      supplierId: novaSupplierId,
      productId: product.id,
      supplierSku: 'BTR-NOVA',
      packSize: '1',
      packUnitId: kgUnit!.id,
    });
    await supplierProductRepository.confirm(novaMapping.id);
    await supplierPriceRepository.recordNewPrice({
      id: generateId(),
      supplierProductId: novaMapping.id,
      unitPrice: '5.00',
      currency: 'USD',
      validFrom: new Date('2026-01-01'),
      sourceDocumentId: docNova,
    });

    const auroraMapping = await supplierProductRepository.create({
      id: generateId(),
      supplierId: auroraSupplierId,
      productId: product.id,
      supplierSku: 'BTR-AURORA',
      packSize: '1',
      packUnitId: kgUnit!.id,
    });
    await supplierProductRepository.confirm(auroraMapping.id);
    await supplierPriceRepository.recordNewPrice({
      id: generateId(),
      supplierProductId: auroraMapping.id,
      unitPrice: '5.90',
      currency: 'USD',
      validFrom: new Date('2026-01-01'),
      sourceDocumentId: docAurora,
    });

    const response = await query('firstFindingReport.generate', token, { storeId, days: 90 });
    const body = JSON.parse(response.body).result.data;
    const crossSupplierFinding = body.findings.find((f: { kind: string }) => f.kind === 'CROSS_SUPPLIER_PRICE');
    expect(crossSupplierFinding).toBeDefined();
    expect(crossSupplierFinding.cheaperSupplierName).toBe('Nova Foods');
    expect(crossSupplierFinding.pricierSupplierName).toBe('Aurora Dairy');
    expect(crossSupplierFinding.percentDifference).toBe('18.0');
  });

  it('returns an honest empty findings list and supplierCount 0 for a store with no approved invoices', async () => {
    const { organizationId, storeId } = await setUpOrgAndStore();
    const token = await issueSession(organizationId, 'OWNER', []);

    const response = await query('firstFindingReport.generate', token, { storeId, days: 90 });
    const body = JSON.parse(response.body).result.data;
    expect(body.findings).toEqual([]);
    expect(body.supplierCount).toBe(0);
  });

  it('404s for a storeId from a different organization (cross-tenant, I4)', async () => {
    const seededA = await setUpOrgAndStore();
    const seededB = await setUpOrgAndStore();
    const tokenB = await issueSession(seededB.organizationId, 'OWNER', []);

    const response = await query('firstFindingReport.generate', tokenB, { storeId: seededA.storeId, days: 90 });
    expect(response.statusCode).toBe(404);
  });
});
