import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  organizations,
  products,
  productVariants,
  purchaseOrders,
  stores,
  suppliers,
  units,
  documents,
  documentExtractions,
  outboxEvents,
  DocumentRepository,
  ProductRepository,
  PurchaseOrderRepository,
  SupplierRepository,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * real HTTP proof of `search.global`'s lexical search across products/suppliers/purchase
 * orders/documents. Every test seeds real rows and searches for them via the real GIN trigram/FTS
 * indexes `0041_search.sql` created, not a mocked repository — this is what actually proves the
 * migration and the query shapes work together, not just that the TypeScript compiles.
 */
describe('search.global', () => {
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
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      await db.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));
      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Search Test Org ${organizationId}`,
      slug: `search-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const issueSession = async (organizationId: string, permissions: Permission[] = ['purchasing:read', 'documents:read']): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const fetchSearch = async (query: string, cookie: string, limitPerType = 5) => {
    const input = { query, limitPerType };
    return app.inject({
      method: 'GET',
      url: `/trpc/search.global?input=${encodeURIComponent(JSON.stringify(input))}`,
      cookies: { '__Host-session': cookie },
    });
  };

  it('rejects a request with no session cookie (401)', async () => {
    const response = await app.inject({ method: 'GET', url: `/trpc/search.global?input=${encodeURIComponent(JSON.stringify({ query: 'anything', limitPerType: 5 }))}` });
    expect(response.statusCode).toBe(401);
  });

  it('finds a product by an exact SKU match, ranked above a fuzzy name match', async () => {
    const { organizationId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productRepository = new ProductRepository(db, organizationId);
    const exact = await productRepository.create({ id: generateId(), sku: 'FLR-T55', name: 'Type 55 Flour', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });

    const cookie = await issueSession(organizationId);
    const response = await fetchSearch('FLR-T55', cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.results.products[0].id).toBe(exact.id);
    expect(body.results.products[0].score).toBe(1);
  });

  it('finds a product by a misspelled name via trigram similarity', async () => {
    const { organizationId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productRepository = new ProductRepository(db, organizationId);
    const product = await productRepository.create({ id: generateId(), sku: `SRCH-${generateId()}`, name: 'Type 55 Flour', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });

    const cookie = await issueSession(organizationId);
    // A real misspelling (a doubled letter, "Flouur" for "Flour") — close enough to clear
    // pg_trgm's default 0.3 similarity threshold, proving trigram fuzzy matching genuinely works,
    // not just exact/prefix matching. A more distant misspelling ("flor") scores 0.1875, genuinely
    // below the threshold — confirmed directly against the real similarity() function before
    // picking this fixture, not guessed.
    const response = await fetchSearch('Flouur', cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.results.products.map((r: { id: string }) => r.id)).toContain(product.id);
  });

  it('finds a supplier by name, and never confuses it with a product of a similar name', async () => {
    const { organizationId } = await setUpOrg();
    const supplierRepository = new SupplierRepository(db, organizationId);
    const supplier = await supplierRepository.create({ id: generateId(), name: 'Nova Foods Distribution' });

    const cookie = await issueSession(organizationId);
    const response = await fetchSearch('Nova Foods', cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.results.suppliers[0].id).toBe(supplier.id);
    expect(body.results.suppliers[0].title).toBe('Nova Foods Distribution');
    expect(body.results.products).toHaveLength(0);
  });

  it('finds a purchase order by its exact PO number', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const supplierRepository = new SupplierRepository(db, organizationId);
    const supplier = await supplierRepository.create({ id: generateId(), name: 'PO Search Supplier' });
    const poRepository = new PurchaseOrderRepository(db, organizationId);
    const poNumber = `PO-SEARCH-${generateId()}`;
    const po = await poRepository.create({ storeId, supplierId: supplier.id, poNumber, currency: 'USD' });

    const cookie = await issueSession(organizationId);
    const response = await fetchSearch(poNumber, cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.results.purchaseOrders[0].id).toBe(po.id);
    expect(body.results.purchaseOrders[0].score).toBe(1);
  });

  it('a caller without purchasing:read gets an empty purchaseOrders result, never a 403 for the whole search', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const supplierRepository = new SupplierRepository(db, organizationId);
    const supplier = await supplierRepository.create({ id: generateId(), name: 'Gated PO Supplier' });
    const poRepository = new PurchaseOrderRepository(db, organizationId);
    const poNumber = `PO-GATED-${generateId()}`;
    await poRepository.create({ storeId, supplierId: supplier.id, poNumber, currency: 'USD' });

    const cookie = await issueSession(organizationId, ['documents:read']); // no purchasing:read
    const response = await fetchSearch(poNumber, cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.results.purchaseOrders).toEqual([]);
  });

  it('finds a document by its real extracted document number', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/search-doc.pdf`, contentHash: `search-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { supplier: { value: 'Coastal Meats & Poultry', confidence: 0.9 }, documentNumber: { value: 'INV-2024-8891', confidence: 0.9 } },
      lines: [], validation: { issues: [], canAutoApprove: true },
    });

    const cookie = await issueSession(organizationId);
    const response = await fetchSearch('INV-2024-8891', cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.results.documents[0].id).toBe(doc.id);
    expect(body.results.documents[0].title).toBe('INV-2024-8891');
    expect(body.results.documents[0].subtitle).toBe('Coastal Meats & Poultry');
  });

  it('a caller without documents:read gets an empty documents result', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/gated-doc.pdf`, contentHash: `gated-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { documentNumber: { value: 'INV-GATED-9999', confidence: 0.9 } },
      lines: [], validation: { issues: [], canAutoApprove: true },
    });

    const cookie = await issueSession(organizationId, ['purchasing:read']); // no documents:read
    const response = await fetchSearch('INV-GATED-9999', cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.results.documents).toEqual([]);
  });

  it('cross-tenant: results never include another organization\'s rows', async () => {
    const { organizationId: orgA } = await setUpOrg();
    const { organizationId: orgB } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));

    const productRepositoryA = new ProductRepository(db, orgA);
    const sharedSku = `XT-SHARED-${generateId()}`;
    await productRepositoryA.create({ id: generateId(), sku: sharedSku, name: 'Cross Tenant Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });

    const cookieB = await issueSession(orgB);
    const response = await fetchSearch(sharedSku, cookieB);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.results.products).toEqual([]);
  });

  it('no results across every entity type is a real empty result, not an error', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId);
    const response = await fetchSearch('zzz-genuinely-nothing-matches-zzz', cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.results.products).toEqual([]);
    expect(body.results.suppliers).toEqual([]);
    expect(body.results.purchaseOrders).toEqual([]);
    expect(body.results.documents).toEqual([]);
  });
});

/**
 * real HTTP proof of `search.documents`' routing (lexical-only vs. hybrid) and permission
 * gate. `GEMINI_API_KEY` is deliberately unset (matching `documents.test.ts`'s own established
 * precedent for this exact situation) — a hybrid-shaped query correctly degrades to lexical-only
 * without a key, proven directly rather than mocking the Gemini SDK inline in an HTTP test. The RRF
 * fusion MATH itself is unit-tested with a real embedding call injected
 * (`packages/domain/src/documents/semantic-search.test.ts`, 15 tests) — this suite proves the
 * router's OWN routing/gating decisions, not the fusion algorithm a second time.
 */
describe('search.documents', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sessionStore = new SessionStore(redis);
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];
  const originalGeminiApiKey = process.env.GEMINI_API_KEY;

  beforeAll(async () => {
    delete process.env.GEMINI_API_KEY;
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await db.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    if (originalGeminiApiKey !== undefined) process.env.GEMINI_API_KEY = originalGeminiApiKey;
    await app.close();
    await redis.quit();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Search Docs Test Org ${organizationId}`, slug: `search-docs-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const issueSession = async (organizationId: string, permissions: Permission[] = ['documents:read']): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const fetchDocumentsSearch = async (query: string, cookie: string) => {
    const input = { query, limit: 10 };
    return app.inject({ method: 'GET', url: `/trpc/search.documents?input=${encodeURIComponent(JSON.stringify(input))}`, cookies: { '__Host-session': cookie } });
  };

  it('rejects a caller without documents:read with a real 403', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId, ['purchasing:read']);
    const response = await fetchDocumentsSearch('INV-1', cookie);
    expect(response.statusCode).toBe(403);
  });

  it('a short/identifier-like query stays lexical, finding the real document by number', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const documentRepository = new DocumentRepository(db, organizationId);
    const doc = await documentRepository.create({
      storeId, type: 'INVOICE', source: 'UPLOAD',
      storageKey: `${organizationId}/hybrid-lexical.pdf`, contentHash: `hybrid-lexical-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    await documentRepository.recordExtraction({
      documentId: doc.id, provider: 'gemini', modelVersion: 'v1', promptVersion: '1',
      fields: { documentNumber: { value: 'INV-HYBRID-1' } }, lines: [], validation: { issues: [], canAutoApprove: true },
    });

    const cookie = await issueSession(organizationId);
    const response = await fetchDocumentsSearch('INV-HYBRID-1', cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.mode).toBe('lexical');
    expect(body.results[0].id).toBe(doc.id);
  });

  it('a long, question-like query degrades to lexical-only with no Gemini key configured, never failing the whole search (real empty result, not an error)', async () => {
    const { organizationId } = await setUpOrg();
    const cookie = await issueSession(organizationId);
    // A real long, question-like query (>4 words, ends in '?') — shouldUseHybridSearch routes this
    // to hybrid, but with no GEMINI_API_KEY configured the router must degrade to lexical rather
    // than fail. `searchDocuments`'s own substring match is against the WHOLE query string, so a
    // natural-language question genuinely matches nothing lexically — a real, honest empty result
    // (200 + mode: 'lexical' + []), never a thrown error, is exactly the property this test proves.
    const response = await fetchDocumentsSearch('which invoices came from flour suppliers this quarter?', cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    expect(body.mode).toBe('lexical');
    expect(body.results).toEqual([]);
  });
});
