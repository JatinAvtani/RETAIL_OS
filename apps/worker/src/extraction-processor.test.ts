import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import {
  createDb,
  documentExtractions,
  documents,
  organizations,
  products,
  stores,
  suppliers,
  supplierProducts,
  supplierPrices,
  units,
  SupplierProductRepository,
  SupplierPriceRepository,
} from '@retailos/db';
import type { ExtractionProvider, ExtractionResult } from '@retailos/ai';
import { createStorageClient, ensureBucketExists, putObjectBytes } from '@retailos/storage';
import type { Job } from 'bullmq';
import { createExtractionProcessor } from './extraction-processor';
import type { ExtractionJobData } from '@retailos/queue';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const BUCKET = 'retailos-documents-worker-test';

const fakeSuccessfulProvider: ExtractionProvider = {
  name: 'fake',
  async extract(): Promise<ExtractionResult> {
    return {
      provider: 'fake',
      modelVersion: 'fake-v1',
      latencyMs: 1,
      error: null,
      fields: {
        supplier: { value: 'Test Supplier', confidence: 0.9 },
        documentNumber: { value: 'INV-1', confidence: 0.9 },
        documentDate: { value: '2026-01-01', confidence: 0.9 },
        currency: { value: 'USD', confidence: 1 },
        subtotal: { value: '10.00', confidence: 0.9 },
        tax: { value: '1.00', confidence: 0.9 },
        discount: { value: null, confidence: null },
        total: { value: '11.00', confidence: 0.9 },
      },
      // Internally consistent with the fields above (10.00 line total + 1.00 tax = 11.00 total) so
      // this fixture reads as a genuinely clean extraction now that 007-07's real gates run against
      // it — a self-contradicting fixture would otherwise silently produce a real TOTAL_MISMATCH.
      lines: [
        {
          sku: { value: 'SKU-1', confidence: 0.9 },
          description: { value: 'Widget', confidence: 0.9 },
          quantity: { value: '2', confidence: 0.9 },
          unit: { value: 'ea', confidence: 0.9 },
          unitPrice: { value: '5.00', confidence: 0.9 },
          lineTotal: { value: '10.00', confidence: 0.9 },
        },
      ],
      overallConfidence: 0.9,
    };
  },
};

const fakeFailingProvider: ExtractionProvider = {
  name: 'fake-failing',
  async extract(): Promise<ExtractionResult> {
    return { provider: 'fake-failing', modelVersion: 'fake-v1', latencyMs: 1, error: 'simulated provider failure', fields: null, lines: null, overallConfidence: null };
  },
};

const asJob = (data: ExtractionJobData): Job<ExtractionJobData> => ({ data }) as Job<ExtractionJobData>;

/**
 * 007-05: real Postgres + real MinIO, a FAKE `ExtractionProvider` (not a real Gemini call — that
 * would be slow/rate-limited and this test is about the processor's own orchestration logic, not
 * Gemini's accuracy, which `packages/ai`'s own tests already cover). Proves the actual job the
 * BullMQ `Worker` runs, not just the pieces it calls.
 */
describe('extraction processor', () => {
  const { db: adminDb } = createDb(ADMIN_CONNECTION_STRING);
  let organizationId: string;
  let storeId: string;
  let documentId: string;

  beforeAll(async () => {
    organizationId = generateId();
    await adminDb.insert(organizations).values({ id: organizationId, name: 'Extraction Processor Test Org', slug: `extraction-processor-test-${organizationId}`, baseCurrency: 'USD' });
    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const storageClient = createStorageClient({ endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET });
    await ensureBucketExists(storageClient, BUCKET);
    await putObjectBytes(storageClient, BUCKET, 'test-invoice.pdf', Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf');
    // A real, OCR-able invoice — the trivial fake PDF above has no readable text at all, which
    // would make the 007-06 circuit-breaker-fallback test's "Tesseract found something real"
    // assertion meaningless regardless of whether the fallback wiring is correct.
    const realInvoiceBytes = readFileSync('../../spikes/extraction/corpus/clean/coastal-meats-55210.pdf');
    await putObjectBytes(storageClient, BUCKET, 'real-invoice.pdf', realInvoiceBytes, 'application/pdf');
  });

  afterEach(async () => {
    if (documentId) {
      await adminDb.delete(documentExtractions).where(eq(documentExtractions.documentId, documentId));
      await adminDb.delete(documents).where(eq(documents.id, documentId));
    }
  });

  afterAll(async () => {
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
  });

  const seedDocument = async (storageKey = 'test-invoice.pdf'): Promise<string> => {
    const id = generateId();
    await adminDb.insert(documents).values({
      id,
      organizationId,
      storeId,
      type: 'OTHER',
      source: 'UPLOAD',
      status: 'UPLOADED',
      storageKey,
      contentHash: 'test-hash',
      mimeType: 'application/pdf',
      sizeBytes: 15,
    });
    return id;
  };

  it('a successful extraction records a document_extractions row and moves the document to REVIEW_REQUIRED', async () => {
    documentId = await seedDocument();

    const processor = createExtractionProcessor({
      databaseUrl: APP_CONNECTION_STRING,
      geminiApiKey: 'unused-because-provider-is-injected',
      storage: { endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET },
      provider: fakeSuccessfulProvider,
    });

    await processor(asJob({ documentId, organizationId, storageKey: 'test-invoice.pdf', mimeType: 'application/pdf' }));

    const [doc] = await adminDb.select().from(documents).where(eq(documents.id, documentId));
    expect(doc?.status).toBe('REVIEW_REQUIRED');

    const [extraction] = await adminDb.select().from(documentExtractions).where(eq(documentExtractions.documentId, documentId));
    expect(extraction?.provider).toBe('fake');
    expect((extraction?.fields as { supplier: { value: string } }).supplier.value).toBe('Test Supplier');
    expect(extraction?.overallConfidence).toBe('0.9000');
  });

  it('a failing provider still records a real document_extractions row (a failed attempt is a data point) and moves the document to REVIEW_REQUIRED', async () => {
    documentId = await seedDocument();

    const processor = createExtractionProcessor({
      databaseUrl: APP_CONNECTION_STRING,
      geminiApiKey: 'unused-because-provider-is-injected',
      storage: { endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET },
      provider: fakeFailingProvider,
    });

    await processor(asJob({ documentId, organizationId, storageKey: 'test-invoice.pdf', mimeType: 'application/pdf' }));

    const [doc] = await adminDb.select().from(documents).where(eq(documents.id, documentId));
    expect(doc?.status).toBe('REVIEW_REQUIRED');

    const [extraction] = await adminDb.select().from(documentExtractions).where(eq(documentExtractions.documentId, documentId));
    expect(extraction).toBeTruthy();
    // fields/lines are NOT NULL columns — a failed attempt still ran, so it gets empty structures,
    // never a bare null (which would misleadingly read as "never attempted").
    expect(extraction?.fields).toEqual({});
    expect(extraction?.lines).toEqual([]);
    expect(extraction?.overallConfidence).toBeNull();
    // The real provider error must survive somewhere — recorded as a validation issue, not silently
    // dropped, so a future review UI can show *why* this extraction produced nothing.
    const validation = extraction?.validation as { issues: { code: string; message: string }[] };
    expect(validation.issues).toHaveLength(1);
    expect(validation.issues[0]?.code).toBe('EXTRACTION_FAILED');
    expect(validation.issues[0]?.message).toBe('simulated provider failure');
  });

  it('007-06: with a real invalid Gemini key and no injected provider, the REAL circuit-breaker-wrapped provider falls back to a REAL Tesseract extraction', async () => {
    documentId = await seedDocument('real-invoice.pdf');

    // No `provider` override — this exercises the REAL construction path
    // (createCircuitBreakerExtractionProvider(createGeminiExtractionProvider(...),
    // createTesseractExtractionProvider(), ...)), not a fake substituted in before the wiring is
    // even reached. A genuinely invalid key makes Gemini's real API call genuinely fail (a real
    // 400/401, not a simulated one), proving the breaker's fallback path is real, wired code, not
    // just unit-tested in isolation.
    const processor = createExtractionProcessor({
      databaseUrl: APP_CONNECTION_STRING,
      geminiApiKey: 'genuinely-invalid-key-to-force-a-real-gemini-failure',
      storage: { endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET },
    });

    await processor(asJob({ documentId, organizationId, storageKey: 'real-invoice.pdf', mimeType: 'application/pdf' }));

    const [doc] = await adminDb.select().from(documents).where(eq(documents.id, documentId));
    expect(doc?.status).toBe('REVIEW_REQUIRED');

    const [extraction] = await adminDb.select().from(documentExtractions).where(eq(documentExtractions.documentId, documentId));
    expect(extraction?.provider).toBe('tesseract'); // real fallback, not gemini — confirms the breaker genuinely routed away from the failing primary.
    expect(extraction?.fields).not.toEqual({}); // Tesseract's real regex parser found at least the header shape on this real invoice.
  }, 30000);

  it('007-07: a content-hash duplicate produces a real DUPLICATE validation issue', async () => {
    const sharedHash = `shared-hash-${generateId()}`;
    const priorId = generateId();
    await adminDb.insert(documents).values({
      id: priorId,
      organizationId,
      storeId,
      type: 'OTHER',
      source: 'UPLOAD',
      status: 'REVIEW_REQUIRED',
      storageKey: 'test-invoice.pdf',
      contentHash: sharedHash,
      mimeType: 'application/pdf',
      sizeBytes: 15,
    });

    documentId = generateId();
    await adminDb.insert(documents).values({
      id: documentId,
      organizationId,
      storeId,
      type: 'OTHER',
      source: 'UPLOAD',
      status: 'UPLOADED',
      storageKey: 'test-invoice.pdf',
      contentHash: sharedHash,
      mimeType: 'application/pdf',
      sizeBytes: 15,
    });

    const processor = createExtractionProcessor({
      databaseUrl: APP_CONNECTION_STRING,
      geminiApiKey: 'unused-because-provider-is-injected',
      storage: { endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET },
      provider: fakeSuccessfulProvider,
    });
    await processor(asJob({ documentId, organizationId, storageKey: 'test-invoice.pdf', mimeType: 'application/pdf' }));

    const [extraction] = await adminDb.select().from(documentExtractions).where(eq(documentExtractions.documentId, documentId));
    const validation = extraction?.validation as { issues: { code: string }[]; canAutoApprove: boolean };
    expect(validation.issues.some((issue) => issue.code === 'DUPLICATE')).toBe(true);
    expect(validation.canAutoApprove).toBe(false);

    await adminDb.delete(documents).where(eq(documents.id, priorId));
  });

  it('007-07: a document whose lines/tax/discount do not reconcile to its stated total produces a real TOTAL_MISMATCH issue', async () => {
    documentId = await seedDocument();

    const inconsistentProvider: ExtractionProvider = {
      name: 'fake-inconsistent',
      async extract(): Promise<ExtractionResult> {
        return {
          provider: 'fake-inconsistent',
          modelVersion: 'fake-v1',
          latencyMs: 1,
          error: null,
          fields: {
            supplier: { value: 'Test Supplier', confidence: 0.9 },
            documentNumber: { value: 'INV-2', confidence: 0.9 },
            documentDate: { value: '2026-01-01', confidence: 0.9 },
            currency: { value: 'USD', confidence: 1 },
            subtotal: { value: '10.00', confidence: 0.9 },
            tax: { value: '0', confidence: 0.9 },
            discount: { value: null, confidence: null },
            total: { value: '999.00', confidence: 0.9 }, // deliberately does not reconcile
          },
          lines: [
            {
              sku: { value: 'SKU-1', confidence: 0.9 },
              description: { value: 'Widget', confidence: 0.9 },
              quantity: { value: '2', confidence: 0.9 },
              unit: { value: 'ea', confidence: 0.9 },
              unitPrice: { value: '5.00', confidence: 0.9 },
              lineTotal: { value: '10.00', confidence: 0.9 },
            },
          ],
          overallConfidence: 0.9,
        };
      },
    };

    const processor = createExtractionProcessor({
      databaseUrl: APP_CONNECTION_STRING,
      geminiApiKey: 'unused-because-provider-is-injected',
      storage: { endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET },
      provider: inconsistentProvider,
    });
    await processor(asJob({ documentId, organizationId, storageKey: 'test-invoice.pdf', mimeType: 'application/pdf' }));

    const [extraction] = await adminDb.select().from(documentExtractions).where(eq(documentExtractions.documentId, documentId));
    const validation = extraction?.validation as { issues: { code: string }[]; canAutoApprove: boolean };
    expect(validation.issues.some((issue) => issue.code === 'TOTAL_MISMATCH')).toBe(true);
    expect(validation.canAutoApprove).toBe(false);
  });

  it('007-07: an extracted unit price more than 5x a confirmed trailing median produces a real PRICE_ANOMALY issue', async () => {
    const supplierId = generateId();
    await adminDb.insert(suppliers).values({ id: supplierId, organizationId, name: `Price Anomaly Supplier ${supplierId}` });

    const [eachUnit] = await adminDb.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    await adminDb.insert(products).values({ id: productId, organizationId, sku: `PA-${productId}`, name: 'Anomaly Test Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });

    const supplierProductRepository = new SupplierProductRepository(adminDb, organizationId);
    const supplierProduct = await supplierProductRepository.create({ id: generateId(), supplierId, productId, supplierSku: 'ANOM-SKU-1' });
    await supplierProductRepository.confirm(supplierProduct.id);

    const supplierPriceRepository = new SupplierPriceRepository(adminDb, organizationId);
    await supplierPriceRepository.recordNewPrice({ id: generateId(), supplierProductId: supplierProduct.id, unitPrice: '4.50', currency: 'USD', validFrom: new Date('2026-01-01') });

    documentId = await seedDocument();
    const anomalousProvider: ExtractionProvider = {
      name: 'fake-anomalous',
      async extract(): Promise<ExtractionResult> {
        return {
          provider: 'fake-anomalous',
          modelVersion: 'fake-v1',
          latencyMs: 1,
          error: null,
          fields: {
            supplier: { value: `Price Anomaly Supplier ${supplierId}`, confidence: 0.9 },
            documentNumber: { value: 'INV-3', confidence: 0.9 },
            documentDate: { value: '2026-01-01', confidence: 0.9 },
            currency: { value: 'USD', confidence: 1 },
            subtotal: { value: '45.00', confidence: 0.9 },
            tax: { value: '0', confidence: 0.9 },
            discount: { value: null, confidence: null },
            total: { value: '45.00', confidence: 0.9 },
          },
          lines: [
            {
              // Decimal-place OCR slip: $4.50 read as $45.00 — exactly the failure class plan.md
              // calls out this gate as existing to catch.
              sku: { value: 'ANOM-SKU-1', confidence: 0.9 },
              description: { value: 'Anomaly Widget', confidence: 0.9 },
              quantity: { value: '1', confidence: 0.9 },
              unit: { value: 'ea', confidence: 0.9 },
              unitPrice: { value: '45.00', confidence: 0.9 },
              lineTotal: { value: '45.00', confidence: 0.9 },
            },
          ],
          overallConfidence: 0.9,
        };
      },
    };

    const processor = createExtractionProcessor({
      databaseUrl: APP_CONNECTION_STRING,
      geminiApiKey: 'unused-because-provider-is-injected',
      storage: { endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET },
      provider: anomalousProvider,
    });
    await processor(asJob({ documentId, organizationId, storageKey: 'test-invoice.pdf', mimeType: 'application/pdf' }));

    const [extraction] = await adminDb.select().from(documentExtractions).where(eq(documentExtractions.documentId, documentId));
    const validation = extraction?.validation as { issues: { code: string }[]; canAutoApprove: boolean };
    expect(validation.issues.some((issue) => issue.code === 'PRICE_ANOMALY')).toBe(true);
    expect(validation.canAutoApprove).toBe(false);

    // FK order: supplier_prices/supplier_products reference products/suppliers, which reference
    // organizations — must be deleted before their parents, same recurring bug class this project
    // has hit repeatedly in shared test fixtures.
    await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, supplierProduct.id));
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.id, supplierProduct.id));
    await adminDb.delete(products).where(eq(products.id, productId));
    await adminDb.delete(suppliers).where(eq(suppliers.id, supplierId));
  });

  it('with no provider configured (no API key, no injected provider), the document is left at PROCESSING and no extraction row is created', async () => {
    documentId = await seedDocument();

    const processor = createExtractionProcessor({
      databaseUrl: APP_CONNECTION_STRING,
      geminiApiKey: undefined,
      storage: { endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin', bucket: BUCKET },
    });

    await processor(asJob({ documentId, organizationId, storageKey: 'test-invoice.pdf', mimeType: 'application/pdf' }));

    const [doc] = await adminDb.select().from(documents).where(eq(documents.id, documentId));
    expect(doc?.status).toBe('PROCESSING');

    const extractionRows = await adminDb.select().from(documentExtractions).where(eq(documentExtractions.documentId, documentId));
    expect(extractionRows).toHaveLength(0);
  });
});
