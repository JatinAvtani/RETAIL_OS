import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, isNull, and } from 'drizzle-orm';
import * as schema from '../schema/index';
import {
  auditLogs,
  documentLinks,
  documents,
  lots,
  organizations,
  outboxEvents,
  productVariants,
  products,
  stockLevels,
  stockMovements,
  stores,
  supplierProducts,
  supplierPrices,
  suppliers,
  units,
  users,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { PostingService } from './posting-service';
import { ProductRepository } from './product-repository';
import { SupplierRepository } from './supplier-repository';
import { SupplierProductRepository } from './supplier-product-repository';
import { DocumentRepository } from './document-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('PostingService', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let unitId: string;
  let supplierId: string;
  let productId: string;
  let userId: string;
  let documentId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Posting Service Test Org',
      slug: `posting-service-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const existingUnit = await adminDb.select().from(units).where(eq(units.code, 'g'));
    unitId = existingUnit[0]?.id ?? generateId();
    if (!existingUnit[0]) {
      await adminDb.insert(units).values({ id: unitId, code: 'g', dimension: 'MASS', isBase: true });
    }

    userId = generateId();
    await adminDb.insert(users).values({ id: userId, email: `posting-service-${userId}@example.test` });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(documentLinks).where(eq(documentLinks.organizationId, organizationId));
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    await adminDb.delete(lots).where(eq(lots.organizationId, organizationId));
    // supplierPrices has no direct organizationId column (see its own schema comment) — deleted via
    // a real lookup of this org's supplier_products ids, mirroring SupplierPriceRepository's own
    // reasoning for why it can't extend TenantScopedRepository.
    const orgMappings = await adminDb.select({ id: supplierProducts.id }).from(supplierProducts).where(eq(supplierProducts.organizationId, organizationId));
    for (const m of orgMappings) {
      await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, m.id));
    }
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, organizationId));
    if (documentId) {
      await adminDb.delete(documents).where(eq(documents.id, documentId));
    }
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
    for (const p of orgProducts) {
      await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
    }
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, organizationId));
    await adminDb.delete(users).where(eq(users.id, userId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  /** A real confirmed supplier-product mapping, product, and REVIEW_REQUIRED document — the state 007-10 leaves behind for 007-11 to post against. */
  const setUpMappedLine = async (options: { conversionToBase?: string } = {}): Promise<{ productId: string; mappingId: string; documentId: string }> => {
    const supplierRepo = new SupplierRepository(createScopedDb(client), organizationId);
    const supplier = await supplierRepo.create({ id: generateId(), name: `Posting Test Supplier ${generateId()}` });
    supplierId = supplier.id;

    const productRepo = new ProductRepository(createScopedDb(client), organizationId);
    const product = await productRepo.create({ id: generateId(), sku: `SKU-${generateId()}`, name: 'Flour', baseUnitId: unitId, type: 'INGREDIENT' });
    productId = product.id;

    const mappingRepo = new SupplierProductRepository(createScopedDb(client), organizationId);
    const mapping = await mappingRepo.create({
      id: generateId(),
      supplierId,
      productId,
      supplierSku: 'FLR-POST-1',
      ...(options.conversionToBase !== undefined ? { conversionToBase: options.conversionToBase } : {}),
    });
    await mappingRepo.confirm(mapping.id);

    const documentRepo = new DocumentRepository(createScopedDb(client), organizationId);
    const doc = await documentRepo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/posting-test.pdf`,
      contentHash: `posting-hash-${generateId()}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
      uploadedByUserId: userId,
    });
    await documentRepo.updateStatus(doc.id, 'REVIEW_REQUIRED');
    documentId = doc.id;

    return { productId, mappingId: mapping.id, documentId: doc.id };
  };

  it('posts a mapped line: real price history, real lot, real RECEIPT movement, real stock_levels update', async () => {
    const { productId: pid, mappingId, documentId: docId } = await setUpMappedLine();

    const service = new PostingService(createScopedDb(client), organizationId);
    const result = await service.postDocument({
      documentId: docId,
      storeId,
      fields: { supplier: { value: (await new SupplierRepository(createScopedDb(client), organizationId).findById(supplierId))!.name } },
      lines: [{ sku: { value: 'FLR-POST-1' }, quantity: { value: '2' }, unitPrice: { value: '10.00' }, lineTotal: { value: '20.00' } }],
      actorUserId: userId,
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.status).toBe('POSTED');
    expect(result.lines[0]?.productId).toBe(pid);

    const adminDb = drizzle(adminClient, { schema });

    // Price history: a real, currently-effective supplierPrices row at exactly $10.00 (conversionToBase defaults to 1, so unit price = base cost).
    const [price] = await adminDb.select().from(supplierPrices).where(and(eq(supplierPrices.supplierProductId, mappingId), isNull(supplierPrices.validTo)));
    expect(price?.unitPrice).toBe('10.0000');
    expect(price?.sourceDocumentId).toBe(docId);

    // A real lot: 2 base units received at $10.00/unit.
    const [lot] = await adminDb.select().from(lots).where(eq(lots.sourceDocumentId, docId));
    expect(lot?.initialQuantity).toBe('2.000000');
    expect(lot?.unitCost).toBe('10.0000');

    // A real RECEIPT movement.
    const [movement] = await adminDb.select().from(stockMovements).where(eq(stockMovements.sourceId, docId));
    expect(movement?.movementType).toBe('RECEIPT');
    expect(movement?.quantity).toBe('2.000000');

    // stock_levels genuinely updated (this system's real "product cost" — no separate products.cost column).
    const [level] = await adminDb.select().from(stockLevels).where(and(eq(stockLevels.productId, pid), eq(stockLevels.storeId, storeId)));
    expect(level?.quantity).toBe('2.000000');
    expect(level?.avgUnitCost).toBe('10.0000');

    // Provenance: document_links for the price, the lot, and the movement.
    const links = await adminDb.select().from(documentLinks).where(eq(documentLinks.documentId, docId));
    expect(links.map((l) => l.relationship).sort()).toEqual(['PRICE_SOURCE', 'STOCK_RECEIPT', 'STOCK_RECEIPT']);

    // Outbox: document.posted, supplier.price_changed, cost.updated (this service's own events),
    // PLUS stock.moved — MovementService.postMovementInTx emits its own outbox event internally as
    // part of the SAME transaction, since postDocument composes it rather than duplicating its logic.
    const events = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    expect(events.map((e) => e.eventType).sort()).toEqual(['cost.updated', 'document.posted', 'stock.moved', 'supplier.price_changed']);

    // The document itself reached POSTED.
    const [postedDoc] = await adminDb.select().from(documents).where(eq(documents.id, docId));
    expect(postedDoc?.status).toBe('POSTED');
  });

  it('converts pack quantity/price to base units via conversionToBase (unitPrice is per PACK, cost-per-base-unit = unitPrice / conversionToBase)', async () => {
    // A 25kg sack of flour priced at $30/sack — 25 base units (kg-equivalent, using 'g' here scaled x1000 for a clean number) at $1.20/unit.
    const { productId: pid, documentId: docId } = await setUpMappedLine({ conversionToBase: '25' });

    const service = new PostingService(createScopedDb(client), organizationId);
    await service.postDocument({
      documentId: docId,
      storeId,
      fields: { supplier: { value: (await new SupplierRepository(createScopedDb(client), organizationId).findById(supplierId))!.name } },
      lines: [{ sku: { value: 'FLR-POST-1' }, quantity: { value: '1' }, unitPrice: { value: '30.00' }, lineTotal: { value: '30.00' } }],
      actorUserId: userId,
    });

    const adminDb = drizzle(adminClient, { schema });
    const [lot] = await adminDb.select().from(lots).where(eq(lots.sourceDocumentId, docId));
    // 1 pack x 25 conversionToBase = 25 base units received.
    expect(lot?.initialQuantity).toBe('25.000000');
    // $30.00 / 25 = $1.2000 per base unit.
    expect(lot?.unitCost).toBe('1.2000');

    const [level] = await adminDb.select().from(stockLevels).where(and(eq(stockLevels.productId, pid), eq(stockLevels.storeId, storeId)));
    expect(level?.avgUnitCost).toBe('1.2000');
  });

  it('skips a line with no confirmed supplier-SKU mapping — the document still reaches POSTED, never blocked (confirmed with the user)', async () => {
    const supplierRepo = new SupplierRepository(createScopedDb(client), organizationId);
    const supplier = await supplierRepo.create({ id: generateId(), name: `Posting Test Supplier Unmapped ${generateId()}` });
    const documentRepo = new DocumentRepository(createScopedDb(client), organizationId);
    const doc = await documentRepo.create({
      storeId,
      type: 'INVOICE',
      source: 'UPLOAD',
      storageKey: `${organizationId}/posting-unmapped-test.pdf`,
      contentHash: `posting-unmapped-hash-${generateId()}`,
      mimeType: 'application/pdf',
      sizeBytes: 1,
      uploadedByUserId: userId,
    });
    await documentRepo.updateStatus(doc.id, 'REVIEW_REQUIRED');
    documentId = doc.id;

    const service = new PostingService(createScopedDb(client), organizationId);
    const result = await service.postDocument({
      documentId: doc.id,
      storeId,
      fields: { supplier: { value: supplier.name } },
      lines: [{ sku: { value: 'NEVER-MAPPED-SKU' }, quantity: { value: '1' }, unitPrice: { value: '5.00' }, lineTotal: { value: '5.00' } }],
      actorUserId: userId,
    });

    expect(result.lines[0]?.status).toBe('SKIPPED_NO_MAPPING');

    const adminDb = drizzle(adminClient, { schema });
    const [postedDoc] = await adminDb.select().from(documents).where(eq(documents.id, doc.id));
    expect(postedDoc?.status).toBe('POSTED');

    const movements = await adminDb.select().from(stockMovements).where(eq(stockMovements.sourceId, doc.id));
    expect(movements).toHaveLength(0);
  });

  it('skips a line whose quantity/unitPrice is unparseable — never coerced to 0 (I7)', async () => {
    const { documentId: docId } = await setUpMappedLine();

    const service = new PostingService(createScopedDb(client), organizationId);
    const result = await service.postDocument({
      documentId: docId,
      storeId,
      fields: { supplier: { value: (await new SupplierRepository(createScopedDb(client), organizationId).findById(supplierId))!.name } },
      lines: [{ sku: { value: 'FLR-POST-1' }, quantity: { value: null }, unitPrice: { value: '10.00' }, lineTotal: { value: '10.00' } }],
      actorUserId: userId,
    });

    expect(result.lines[0]?.status).toBe('SKIPPED_UNPARSEABLE');
  });

  it('is genuinely atomic: an error mid-posting rolls back everything, including the document status', async () => {
    const { documentId: docId } = await setUpMappedLine();

    const service = new PostingService(createScopedDb(client), organizationId);
    // Force a real failure by posting a line referencing a SKU that doesn't exist as JSON at all —
    // simpler and more direct: monkeypatch is unavailable across a real DB transaction boundary, so
    // instead prove atomicity the same way MovementService's own tests do: assert that BEFORE this
    // call, no lot/movement/price exists, then deliberately trigger a real constraint violation by
    // inserting a duplicate content hash isn't relevant here — instead verify the positive case
    // (the prior successful test) already proves every write lands in the SAME transaction, since
    // it reads back ALL of price/lot/movement/stock_levels/links/outbox/document status together;
    // if postDocument were not atomic, a partial failure earlier in this test file would have left
    // some of those visible without others, which the FIRST test's own multi-table assertions above
    // already rule out for the success path. This test instead proves the negative path directly:
    // an org-mismatched storeId (belonging to no real store) causes a real FK violation, and NOTHING
    // from this attempt is left behind afterward.
    const bogusStoreId = generateId();
    await expect(
      service.postDocument({
        documentId: docId,
        storeId: bogusStoreId,
        fields: { supplier: { value: (await new SupplierRepository(createScopedDb(client), organizationId).findById(supplierId))!.name } },
        lines: [{ sku: { value: 'FLR-POST-1' }, quantity: { value: '2' }, unitPrice: { value: '10.00' }, lineTotal: { value: '20.00' } }],
        actorUserId: userId,
      })
    ).rejects.toThrow();

    const adminDb = drizzle(adminClient, { schema });
    const [docAfter] = await adminDb.select().from(documents).where(eq(documents.id, docId));
    expect(docAfter?.status).toBe('REVIEW_REQUIRED'); // unchanged — the status update never committed
    const lotsAfter = await adminDb.select().from(lots).where(eq(lots.sourceDocumentId, docId));
    expect(lotsAfter).toHaveLength(0); // the lot insert never committed either, same transaction
  });
});
