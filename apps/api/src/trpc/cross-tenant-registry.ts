import {
  createDb,
  categories,
  documentExtractions,
  documents,
  lots,
  memberships,
  menuItems,
  posConnections,
  posItems,
  products,
  productVariants,
  purchaseOrderLines,
  purchaseOrders,
  recipeComponents,
  recipes,
  salesCsvImports,
  storageLocations,
  stores,
  suppliers,
  supplierProducts,
  units,
  users,
  StockCountService,
  PurchaseOrderRepository,
  GoodsReceiptRepository,
  InvoiceMatchRepository,
  InvitationRepository,
  ConversationRepository,
  NotificationRepository,
  NotificationRuleRepository,
} from '@retailos/db';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { generateId } from '@retailos/domain';
import { encryptToken } from '@retailos/pos';
import { buildProductImageKey, buildCsvImportKey, buildDocumentKey, buildGoodsReceiptLinePhotoKey, createPresignedUploadUrl, ensureBucketExists } from '@retailos/storage';
import { PRODUCT_IMAGES_BUCKET, SALES_CSV_IMPORTS_BUCKET, DOCUMENTS_BUCKET, GOODS_RECEIPT_PHOTOS_BUCKET, storageClient } from './context';

type Db = ReturnType<typeof createDb>['db'];

/**
 * The design: "enumerate every registered route; for each, call with tenant B's session against a
 * tenant A resource id. Expect 403/404, never 200." This is the registry half of that suite (see
 * `cross-tenant.test.ts` for the runner) — a real, generic auto-attacker can't be built without
 * SOME per-endpoint knowledge, because there is no mechanical way to derive "what a resource id
 * looks like for this procedure" from a tRPC router alone (`stores.get` needs `{ id: storeId }`;
 * a hypothetical future `purchasing.get` might need `{ id: poId }`; an endpoint with no resource
 * id at all, like `invitations.create`, isn't in scope for THIS check — it has nothing to attack
 * by id).
 *
 * The reusable part — and what makes this "every future endpoint inherits it automatically" true
 * in practice — is the RUNNER, not this file. Adding cross-tenant coverage for a new endpoint is
 * one entry here (seed a resource, describe its shape), not a new hand-written test file.
 */
export type ResourceScopedProcedure = {
  /** Dotted tRPC path, e.g. 'stores.get'. */
  path: string;
  /** 'query' procedures are called via GET + ?input=; 'mutation' via POST + JSON body. */
  type: 'query' | 'mutation';
  /** Seeds a real resource belonging to `organizationId` and returns its id. */
  seedResource: (db: Db, organizationId: string) => Promise<string>;
  /**
   * Builds the procedure's input given the (attacker-supplied) resource id, its owning org, and
   * a real db handle — most entries don't need `db` (their id alone is the whole payload), but a
   * `create`-shaped attack (e.g. products.create referencing another tenant's categoryId) needs
   * one real value looked up fresh (a global unit id) so the "own resource" positive case gets a
   * genuine 200, not an incidental failure unrelated to what the entry is actually testing.
   */
  buildInput: (
    resourceId: string,
    organizationId: string,
    db: Db
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
};

/** Seeds a real product (needs a real baseUnitId FK — 'each' is part of the seeded global vocabulary). */
const seedProduct = async (db: Db, organizationId: string): Promise<string> => {
  const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
  if (!eachUnit) {
    throw new Error("Cross-tenant registry: seeded unit 'each' not found — migrations not applied?");
  }
  const productId = generateId();
  await db.insert(products).values({
    id: productId,
    organizationId,
    sku: `cross-tenant-probe-${productId}`,
    name: `Cross-tenant probe product ${productId}`,
    baseUnitId: eachUnit.id,
    type: 'INGREDIENT',
  });
  return productId;
};

/** Seeds a real root category. */
const seedCategory = async (db: Db, organizationId: string): Promise<string> => {
  const categoryId = generateId();
  await db.insert(categories).values({
    id: categoryId,
    organizationId,
    name: `Cross-tenant probe category ${categoryId}`,
    path: `/${categoryId}`,
  });
  return categoryId;
};

/** Seeds a real pending invitation via the actual repository method (not a raw insert) — the invitation.revoke entry's real resource. */
const seedInvitation = async (db: Db, organizationId: string): Promise<string> => {
  const invitationRepository = new InvitationRepository(db, organizationId);
  const inviterId = generateId();
  await db.insert(users).values({ id: inviterId, email: `cross-tenant-probe-inviter-${inviterId}@example.test` });
  const { invitationId } = await invitationRepository.create({
    email: `cross-tenant-probe-invitee-${generateId()}@example.test`,
    role: 'STAFF',
    storeIds: null,
    invitedBy: inviterId,
  });
  return invitationId;
};

/** Seeds a real accepted membership — a real, second user joined to the org, the shape `invitations.updateRole`/`removeMember` operate on. */
const seedMembership = async (db: Db, organizationId: string): Promise<string> => {
  const userId = generateId();
  await db.insert(users).values({ id: userId, email: `cross-tenant-probe-member-${userId}@example.test` });
  const membershipId = generateId();
  await db.insert(memberships).values({
    id: membershipId,
    organizationId,
    userId,
    role: 'STAFF',
    storeIds: null,
    acceptedAt: new Date(),
  });
  return membershipId;
};

/** Seeds a real store — the same shape as the `stores.get` entry below, factored out since the inventory endpoints are all store-scoped too. */
const seedStore = async (db: Db, organizationId: string): Promise<string> => {
  const storeId = generateId();
  await db.insert(stores).values({
    id: storeId,
    organizationId,
    name: `Cross-tenant probe store ${storeId}`,
    timezone: 'America/New_York',
  });
  return storeId;
};

/** Seeds a real store + product + default variant together — the shape every inventory endpoint needs (they're store-scoped, not just product-scoped). Returns the store id, since `assertStoreAccess` is always the FIRST check these procedures run — attacking with tenant A's storeId is the actual cross-tenant surface being tested, exactly as it is for `stores.get` itself. `seedProduct` (a plain raw insert, written for entries that never needed a variant) does NOT insert a `product_variants` row — the real `ProductRepository.create` does that as its own invariant, but this registry seeds fixtures directly rather than through the repository, so the variant is inserted explicitly here. */
const seedStoreAndProduct = async (
  db: Db,
  organizationId: string
): Promise<{ storeId: string; productId: string; variantId: string }> => {
  const storeId = await seedStore(db, organizationId);
  const productId = await seedProduct(db, organizationId);
  const variantId = generateId();
  await db.insert(productVariants).values({ id: variantId, productId, name: 'Cross-tenant probe variant', isDefault: true });
  return { storeId, productId, variantId };
};

/** Seeds a store + product + variant + a real ACTIVE lot with stock — what `inventory.logWaste`/`logWasteFromLot`'s "own resource" case genuinely needs to succeed (waste logging draws from `lots`, not merely from a product's existence). */
const seedStoreProductWithLot = async (
  db: Db,
  organizationId: string
): Promise<{ storeId: string; productId: string; variantId: string; lotId: string }> => {
  const { storeId, productId, variantId } = await seedStoreAndProduct(db, organizationId);
  const lotId = generateId();
  await db.insert(lots).values({
    id: lotId,
    organizationId,
    storeId,
    productId,
    variantId,
    receivedAt: new Date(),
    initialQuantity: '10.000000',
    remainingQuantity: '10.000000',
    unitCost: '1.0000',
    currency: 'USD',
    status: 'ACTIVE',
  });
  return { storeId, productId, variantId, lotId };
};

/** Seeds a real, one-line DRAFT stock count in tenant A's own store. */
const seedStockCount = async (db: Db, organizationId: string): Promise<string> => {
  const { storeId, productId, variantId } = await seedStoreAndProduct(db, organizationId);
  const service = new StockCountService(db, organizationId);
  const count = await service.createCount({
    storeId,
    scope: 'full',
    productVariantPairs: [{ productId, variantId }],
  });
  return count.id;
};

/** Seeds a real, one-line DRAFT stock count and returns its single line's id — for `setLineReason`, which is scoped by `stockCountLineId`, not `stockCountId`, and doesn't require any particular count status. */
const seedStockCountLine = async (db: Db, organizationId: string): Promise<string> => {
  const { storeId, productId, variantId } = await seedStoreAndProduct(db, organizationId);
  const service = new StockCountService(db, organizationId);
  const count = await service.createCount({
    storeId,
    scope: 'full',
    productVariantPairs: [{ productId, variantId }],
  });
  const lines = await service.findLines(count.id);
  if (!lines[0]) {
    throw new Error('Cross-tenant registry: seeded stock count has no line — createCount invariant broken?');
  }
  return lines[0].id;
};

/** Seeds a stock count already started (IN_PROGRESS) — the real starting state `submit` (and `enterCount`, which submit's own test needs anyway) require. `start` itself is tested against a plain DRAFT count from `seedStockCount`, since DRAFT is exactly what `start` needs to succeed. */
const seedInProgressStockCount = async (db: Db, organizationId: string): Promise<string> => {
  const countId = await seedStockCount(db, organizationId);
  const service = new StockCountService(db, organizationId);
  await service.startCount(countId);
  return countId;
};

/** Seeds a stock count IN_PROGRESS with every line already counted (at exactly its frozen theoretical quantity, so variance is zero) — the real starting state `submit` requires: `submitCount` throws a plain Error if any line's `countedQuantity` is still null, which a bare `startCount`-only fixture would trigger regardless of who's calling. */
const seedInProgressStockCountFullyCounted = async (db: Db, organizationId: string): Promise<string> => {
  const countId = await seedInProgressStockCount(db, organizationId);
  const service = new StockCountService(db, organizationId);
  const lines = await service.findLines(countId);
  for (const line of lines) {
    await service.enterCount(line.id, line.theoreticalQuantityT0 ?? '0');
  }
  return countId;
};

/** Seeds a stock count already submitted (SUBMITTED) — the real starting state `approve`/`reject` require. Every line is counted at exactly its frozen theoretical quantity, so variance is zero and approval never hits the large-variance-needs-a-reason path — this entry is testing the cross-tenant guard, not that specific business rule (which `inventory-business-logic.test.ts` already covers directly). */
const seedSubmittedStockCount = async (db: Db, organizationId: string): Promise<string> => {
  const countId = await seedInProgressStockCountFullyCounted(db, organizationId);
  const service = new StockCountService(db, organizationId);
  await service.submitCount(countId);
  return countId;
};

/** Seeds a stock count already started, and returns its single line's id — the real starting state `enterCount` needs (a DRAFT count's lines have no `theoreticalQuantityT0` snapshot yet, but `enterCount` itself doesn't require IN_PROGRESS specifically; this just matches the realistic flow). */
const seedInProgressStockCountLine = async (db: Db, organizationId: string): Promise<string> => {
  const countId = await seedInProgressStockCount(db, organizationId);
  const service = new StockCountService(db, organizationId);
  const lines = await service.findLines(countId);
  if (!lines[0]) {
    throw new Error('Cross-tenant registry: seeded stock count has no line — createCount invariant broken?');
  }
  return lines[0].id;
};

/** Seeds a store + supplier + confirmed supplier_product — what every purchase-order registry entry below needs as its base fixture. */
const seedStoreSupplierAndSupplierProduct = async (
  db: Db,
  organizationId: string
): Promise<{ storeId: string; supplierId: string; productId: string; supplierProductId: string }> => {
  const { storeId, productId } = await seedStoreAndProduct(db, organizationId);
  const supplierId = generateId();
  // A real contact email — `purchaseOrders.send`'s own-resource case needs one to
  // genuinely reach a 200; every OTHER registry entry using this shared fixture only reads
  // storeId/supplierId/productId/supplierProductId, so this addition is inert for them.
  await db.insert(suppliers).values({
    id: supplierId,
    organizationId,
    name: `Cross-tenant probe supplier ${supplierId}`,
    contacts: [{ name: 'Probe Contact', email: `probe-${supplierId}@example.test` }],
  });
  const supplierProductId = generateId();
  await db.insert(supplierProducts).values({
    id: supplierProductId,
    organizationId,
    supplierId,
    productId,
    supplierSku: `CROSS-TENANT-PROBE-${supplierProductId}`,
    isConfirmed: true,
  });
  return { storeId, supplierId, productId, supplierProductId };
};

/** A real DRAFT purchase order with no lines — what `purchaseOrders.get`/`addLine` need as their own-resource fixture. */
const seedDraftPurchaseOrder = async (db: Db, organizationId: string): Promise<string> => {
  const { storeId, supplierId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
  const repo = new PurchaseOrderRepository(db, organizationId);
  const created = await repo.create({ storeId, supplierId, poNumber: `CROSS-TENANT-PROBE-${generateId()}`, currency: 'USD' });
  return created.id;
};

/** A real DRAFT purchase order WITH one real line — what `submit` needs (submit itself has no line-count requirement, but a realistic PO always has at least one). */
const seedDraftPurchaseOrderWithLine = async (db: Db, organizationId: string): Promise<string> => {
  const { supplierProductId, productId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
  const purchaseOrderId = await seedDraftPurchaseOrder(db, organizationId);
  const repo = new PurchaseOrderRepository(db, organizationId);
  await repo.addLine({
    purchaseOrderId,
    supplierProductId,
    productId,
    quantityOrderUnits: '1',
    conversionToBase: '1',
    unitPrice: '10.00',
    lineNumber: 1,
  });
  return purchaseOrderId;
};

/** A real PENDING_APPROVAL purchase order — what `approve`/`reject` need as their own-resource starting state. */
const seedPendingApprovalPurchaseOrder = async (db: Db, organizationId: string): Promise<string> => {
  const purchaseOrderId = await seedDraftPurchaseOrderWithLine(db, organizationId);
  const repo = new PurchaseOrderRepository(db, organizationId);
  await repo.applyTransition(purchaseOrderId, 'SUBMIT', 1);
  return purchaseOrderId;
};

/** A real APPROVED purchase order — what `send` needs as its own-resource starting state. */
const seedApprovedPurchaseOrder = async (db: Db, organizationId: string): Promise<string> => {
  const purchaseOrderId = await seedPendingApprovalPurchaseOrder(db, organizationId);
  const repo = new PurchaseOrderRepository(db, organizationId);
  await repo.applyTransition(purchaseOrderId, 'APPROVE', 2);
  return purchaseOrderId;
};

/**
 * a real SENT purchase order — `goodsReceipts.confirmReceipt`'s own-resource starting
 * state. Returns the PO's real `purchaseOrderLineId` (not the PO id itself) since that's the
 * actual attack surface: `confirmReceipt` takes a `purchaseOrderLineId` per line, and the real
 * cross-tenant risk is tenant B posting a receipt against tenant A's real PO line.
 */
const seedSentPurchaseOrderWithLine = async (db: Db, organizationId: string): Promise<string> => {
  const purchaseOrderId = await seedApprovedPurchaseOrder(db, organizationId);
  const repo = new PurchaseOrderRepository(db, organizationId);
  await repo.applyTransition(purchaseOrderId, 'SEND', 3);
  const lines = await repo.findLines(purchaseOrderId);
  if (!lines[0]) {
    throw new Error('Cross-tenant registry: seeded SENT purchase order has no line — seedDraftPurchaseOrderWithLine invariant broken?');
  }
  return lines[0].id;
};

/** A real confirmed goods receipt — `goodsReceipts.get`'s own-resource starting state. */
const seedGoodsReceipt = async (db: Db, organizationId: string): Promise<string> => {
  const result = await seedGoodsReceiptAndLine(db, organizationId);
  return result.goodsReceiptId;
};

/**
 * a real confirmed goods-receipt LINE — `goodsReceipts.requestPhotoUpload`/
 * `.confirmPhotoUpload`'s own-resource starting state, since both take a `goodsReceiptLineId`
 * directly, not a `goodsReceiptId`. Shares the same confirm-a-real-receipt logic
 * `seedGoodsReceipt` uses, factored out so both can return whichever id their own registry entry
 * actually attacks with.
 */
const seedGoodsReceiptAndLine = async (db: Db, organizationId: string): Promise<{ goodsReceiptId: string; goodsReceiptLineId: string }> => {
  const purchaseOrderLineId = await seedSentPurchaseOrderWithLine(db, organizationId);
  const [line] = await db.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId, storeId: purchaseOrders.storeId, supplierId: purchaseOrders.supplierId })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .where(eq(purchaseOrderLines.id, purchaseOrderLineId));
  if (!line) {
    throw new Error('Cross-tenant registry: seedGoodsReceiptAndLine could not resolve its own seeded PO line.');
  }
  const repo = new GoodsReceiptRepository(db, organizationId);
  const result = await repo.confirmReceipt({
    storeId: line.storeId,
    purchaseOrderId: line.purchaseOrderId,
    supplierId: line.supplierId,
    receivedAt: new Date(),
    lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits: '1', lineNumber: 1 }],
  });
  const receiptLines = await repo.findLines(result.goodsReceiptId);
  if (!receiptLines[0]) {
    throw new Error('Cross-tenant registry: seedGoodsReceiptAndLine produced a receipt with no line.');
  }
  return { goodsReceiptId: result.goodsReceiptId, goodsReceiptLineId: receiptLines[0].id };
};

/** Seeds a real, one-component recipe (a real product component, needs a real baseUnitId/unitId). */
const seedRecipe = async (db: Db, organizationId: string): Promise<string> => {
  const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
  if (!eachUnit) {
    throw new Error("Cross-tenant registry: seeded unit 'each' not found — migrations not applied?");
  }
  const productId = await seedProduct(db, organizationId);
  const recipeGroupId = generateId();
  const recipeId = generateId();
  await db.insert(recipes).values({
    id: recipeId,
    recipeGroupId,
    organizationId,
    name: `Cross-tenant probe recipe ${recipeGroupId}`,
    yieldQuantity: '1',
    yieldUnitId: eachUnit.id,
    validFrom: new Date(),
  });
  await db.insert(recipeComponents).values({
    id: generateId(),
    recipeId,
    componentType: 'PRODUCT',
    productId,
    quantity: '1',
    unitId: eachUnit.id,
  });
  return recipeGroupId;
};

/**
 * `integrations.syncSquareCatalog` requires `SQUARE_APPLICATION_ID`/`SQUARE_APPLICATION_SECRET`/
 * `SQUARE_REDIRECT_URI` (else the router itself returns 503 before ever reaching the connection
 * lookup) and `POS_TOKEN_ENCRYPTION_KEY` (else decrypting the seeded connection's token throws) —
 * neither is set anywhere in this suite's real env, same gap `square-routes.test.ts` already solved
 * for OAuth by setting test values in its own `beforeAll`. Set once here, only if genuinely unset,
 * so a real local `.env.local` value (if the user ever configures one) always wins.
 */
if (!process.env.SQUARE_APPLICATION_ID) process.env.SQUARE_APPLICATION_ID = 'cross-tenant-test-square-app-id';
if (!process.env.SQUARE_APPLICATION_SECRET) process.env.SQUARE_APPLICATION_SECRET = 'cross-tenant-test-square-app-secret';
if (!process.env.SQUARE_REDIRECT_URI) process.env.SQUARE_REDIRECT_URI = 'http://localhost:3001/integrations/square/callback';
if (!process.env.POS_TOKEN_ENCRYPTION_KEY) process.env.POS_TOKEN_ENCRYPTION_KEY = 'cross-tenant-registry-test-key';

/**
 * `documents.confirmUpload`'s own-resource-succeeds case below runs the REAL router
 * mutation, which now classifies via a real Gemini call if `GEMINI_API_KEY` is set — same
 * "avoid a real, unreliable external call in the merge-gate suite" reasoning as
 * `patchFetchForSquare` below, opposite direction (there's nothing to fake a response WITH here,
 * since the SDK isn't a plain `fetch` call, so this suite instead forces the documented
 * "classification not attempted" path deterministically, same fix as `documents.test.ts`).
 */
delete process.env.GEMINI_API_KEY;

/**
 * `integrations.syncSquareCatalog`/`syncSquareOrders` call Square's real Catalog/Orders APIs — no
 * live Square sandbox app exists in this codebase yet,
 * so their "own resource succeeds with a genuine 200" case cannot go over the real network the way
 * `square-routes.test.ts` accepts for OAuth's error-path tests. Unlike those, THIS suite's second
 * `it.each` genuinely asserts 200, which a real, unreachable Square sandbox cannot produce — so
 * `global.fetch` is patched narrowly (Square's own host only; every other request, including
 * `products.confirmImageUpload`'s real MinIO PUT earlier in this same file, passes through
 * untouched) to return one realistic, minimal empty-page response per endpoint. This proves each
 * router's own auth/store/connection-lookup logic — the actual cross-tenant surface this suite
 * exists to test — without needing to fake Square's business data, which
 * `packages/pos/src/square.catalog.test.ts`/`square.orders.test.ts` are responsible for instead.
 */
let squareFetchPatched = false;
const patchFetchForSquare = (): void => {
  if (squareFetchPatched) return;
  squareFetchPatched = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/v2/orders/search') && (url.includes('squareupsandbox.com') || url.includes('squareup.com'))) {
      return new Response(JSON.stringify({ orders: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('squareupsandbox.com') || url.includes('squareup.com')) {
      return new Response(JSON.stringify({ objects: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
};

/** Seeds a real, CONNECTED Square pos_connections row for a store, with a real externalLocationId — what syncSquareCatalog's/syncSquareOrders' own auth/store/connection-lookup checks need to reach the (patched) Square API call at all. */
const seedPosConnection = async (db: Db, organizationId: string): Promise<string> => {
  patchFetchForSquare();
  const storeId = await seedStore(db, organizationId);
  await db.insert(posConnections).values({
    id: generateId(),
    organizationId,
    storeId,
    vendor: 'square',
    externalAccountId: `cross-tenant-probe-merchant-${storeId}`,
    externalLocationId: `cross-tenant-probe-location-${storeId}`,
    accessTokenCiphertext: encryptToken('probe-access-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
    refreshTokenCiphertext: encryptToken('probe-refresh-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
    status: 'CONNECTED',
  });
  return storeId;
};

const CROSS_TENANT_PROBE_CSV = 'occurred_at,item,qty,price\n2026-08-01,Probe Item,1,1.00\n';

// Only the magic-byte prefix matters to detectDocumentFormat (the first 5 bytes, "%PDF-") — not a
// structurally valid PDF, just enough to pass upload-time format verification for these probes.
const CROSS_TENANT_PROBE_PDF = Buffer.from('%PDF-1.4\n%%EOF');

/** Seeds a real, UPLOADED sales_csv_imports row with a genuine CSV object in MinIO at the exact key `storageKey` names — same reasoning as `products.confirmImageUpload`'s real-JPEG upload: the OWN-resource positive case needs a genuine object to read back, not an incidental S3 404. Returns the import id, since every csvImport.* procedure past requestUpload is scoped by importId. */
const seedCsvImport = async (db: Db, organizationId: string): Promise<string> => {
  const storeId = await seedStore(db, organizationId);
  const importId = generateId();
  await ensureBucketExists(storageClient, SALES_CSV_IMPORTS_BUCKET);
  const key = buildCsvImportKey(organizationId, importId);
  const uploadUrl = await createPresignedUploadUrl(storageClient, SALES_CSV_IMPORTS_BUCKET, key, 'text/csv');
  await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: CROSS_TENANT_PROBE_CSV });
  await db.insert(salesCsvImports).values({
    id: importId,
    organizationId,
    storeId,
    storageKey: key,
    status: 'UPLOADED',
    detectedHeaders: { headers: ['occurred_at', 'item', 'qty', 'price'], sampleRows: [['2026-08-01', 'Probe Item', '1', '1.00']], delimiter: ',' },
  });
  return importId;
};

/** Seeds a real, UPLOADED documents row with a genuine (magic-byte-valid) PDF object in MinIO at the exact key `storageKey` names — same reasoning as `seedCsvImport`. Returns `{ storeId, documentId }`: `storeId` for `documents.list` (store-scoped), `documentId` for `documents.get`. */
const seedDocument = async (db: Db, organizationId: string): Promise<{ storeId: string; documentId: string }> => {
  const storeId = await seedStore(db, organizationId);
  const documentId = generateId();
  await ensureBucketExists(storageClient, DOCUMENTS_BUCKET);
  const key = buildDocumentKey(organizationId, documentId, 'pdf');
  const uploadUrl = await createPresignedUploadUrl(storageClient, DOCUMENTS_BUCKET, key, 'application/pdf');
  await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: CROSS_TENANT_PROBE_PDF });
  await db.insert(documents).values({
    id: documentId,
    organizationId,
    storeId,
    type: 'OTHER',
    source: 'UPLOAD',
    status: 'UPLOADED',
    storageKey: key,
    contentHash: createHash('sha256').update(CROSS_TENANT_PROBE_PDF).digest('hex'),
    mimeType: 'application/pdf',
    sizeBytes: CROSS_TENANT_PROBE_PDF.length,
  });
  return { storeId, documentId };
};

/** Seeds a real, UNMAPPED pos_items row in a real store — what `posItems.listUnmapped`/`mapToMenuItem`/`ignore`'s own-resource case needs. Returns the store id for `listUnmapped` (store-scoped), and the caller resolves the item id itself for the id-scoped mutations, same shape as `inventory.movements`' product lookup. */
const seedPosItem = async (db: Db, organizationId: string): Promise<{ storeId: string; posItemId: string }> => {
  const storeId = await seedStore(db, organizationId);
  const posItemId = generateId();
  await db.insert(posItems).values({
    id: posItemId,
    organizationId,
    storeId,
    source: 'square',
    externalId: `cross-tenant-probe-${posItemId}`,
    name: `Cross-tenant probe pos item ${posItemId}`,
    mappingStatus: 'UNMAPPED',
  });
  return { storeId, posItemId };
};

/** Same as `seedDocument`, but already at `REVIEW_REQUIRED` with a real extraction row — what `documents.getForReview`/`documents.approve`/`documents.reject`'s own-resource cases need to reach a genuine 200/2xx, not a 400 ("not awaiting review") that would mask a real cross-tenant bug behind an unrelated status code. */
const seedDocumentAwaitingReview = async (db: Db, organizationId: string): Promise<{ storeId: string; documentId: string }> => {
  const seeded = await seedDocument(db, organizationId);
  await db.insert(documentExtractions).values({
    id: generateId(),
    organizationId,
    documentId: seeded.documentId,
    provider: 'gemini',
    modelVersion: 'flash-lite-v1',
    promptVersion: '1',
    fields: { supplier: { value: 'Cross-tenant probe supplier', confidence: 0.9 } },
    lines: [],
    validation: { issues: [], canAutoApprove: true },
    overallConfidence: '0.9000',
  });
  await db.update(documents).set({ status: 'REVIEW_REQUIRED' }).where(eq(documents.id, seeded.documentId));
  return seeded;
};

/**
 * a real `InvoiceMatch` — `invoiceMatches.get`/`.getByDocument`'s own-resource starting
 * state. Reuses `seedStoreSupplierAndSupplierProduct`'s real confirmed mapping and calls
 * `InvoiceMatchRepository.runMatch` directly (the same repository `documents.approve` calls
 * internally) rather than driving a full document-approve flow — this line is intentionally
 * unmatched against any PO/receipt (an `UNORDERED_ITEM` result), since the registry only needs a
 * real row to attack, not a specific variance outcome.
 */
const seedInvoiceMatch = async (db: Db, organizationId: string): Promise<{ storeId: string; invoiceMatchId: string }> => {
  const { storeId, supplierId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
  const documentId = generateId();
  await db.insert(documents).values({
    id: documentId,
    organizationId,
    storeId,
    type: 'INVOICE',
    source: 'UPLOAD',
    status: 'POSTED',
    storageKey: `${organizationId}/cross-tenant-probe-invoice-${documentId}.pdf`,
    contentHash: createHash('sha256').update(`invoice-match-probe-${documentId}`).digest('hex'),
    mimeType: 'application/pdf',
    sizeBytes: 1,
  });
  const [supplier] = await db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, supplierId));
  const repo = new InvoiceMatchRepository(db, organizationId);
  const result = await repo.runMatch({
    documentId,
    storeId,
    supplierName: supplier!.name,
    lines: [{ sku: { value: `cross-tenant-probe-invoice-sku-${generateId()}` }, quantity: { value: '1' }, unitPrice: { value: '1.00' } }],
  });
  return { storeId, invoiceMatchId: result.id };
};

/**
 * `documents.confirmLineMapping`'s own-resource case needs MORE than
 * `seedDocumentAwaitingReview` — a real line item with a real SKU, and a real `suppliers` row whose
 * name exactly matches the extraction's `fields.supplier.value` (the endpoint's own resolution rule,
 * matching the extraction validation-gate precedent), plus a real product to map to. Returns just the
 * document id (the resource under attack, matching every other entry's shape) — `buildInput` looks
 * up a real product fresh via `organizationId` (always tenant A's, per the runner's own contract:
 * `buildInput(resourceId, tenantA.organizationId, db)` regardless of which tenant is calling), since
 * `productId` must be one of tenant A's real products in BOTH the attack and own-resource cases.
 */
const seedDocumentAwaitingReviewWithLine = async (db: Db, organizationId: string): Promise<string> => {
  const seeded = await seedDocument(db, organizationId);
  const supplierId = generateId();
  await db.insert(suppliers).values({ id: supplierId, organizationId, name: `Cross-tenant probe supplier ${supplierId}` });
  await seedProduct(db, organizationId);

  await db.insert(documentExtractions).values({
    id: generateId(),
    organizationId,
    documentId: seeded.documentId,
    provider: 'gemini',
    modelVersion: 'flash-lite-v1',
    promptVersion: '1',
    fields: { supplier: { value: `Cross-tenant probe supplier ${supplierId}`, confidence: 0.9 } },
    lines: [
      {
        sku: { value: `cross-tenant-probe-sku-${generateId()}`, confidence: 0.6 },
        description: { value: 'Cross-tenant probe line', confidence: 0.6 },
        quantity: { value: '1', confidence: 0.9 },
        unit: { value: 'ea', confidence: 0.9 },
        unitPrice: { value: '1.00', confidence: 0.9 },
        lineTotal: { value: '1.00', confidence: 0.9 },
      },
    ],
    validation: { issues: [], canAutoApprove: true },
    overallConfidence: '0.7500',
  });
  await db.update(documents).set({ status: 'REVIEW_REQUIRED' }).where(eq(documents.id, seeded.documentId));
  return seeded.documentId;
};

/** Seeds a real menu item — what `posItems.mapToMenuItem`'s own-resource case needs to reach a genuine 200 (a real menuItemId to map to, not a fake one that would 404 regardless of tenant). */
const seedMenuItem = async (db: Db, organizationId: string): Promise<string> => {
  const menuItemId = generateId();
  await db.insert(menuItems).values({
    id: menuItemId,
    organizationId,
    name: `Cross-tenant probe menu item ${menuItemId}`,
    recipeGroupId: generateId(),
    price: '5.0000',
    priceValidFrom: new Date(),
  });
  return menuItemId;
};

/** Same as `seedCsvImport`, but already `MAPPED` — what `csvImport.commit`'s own-resource case needs to reach a genuine 200. */
const seedMappedCsvImport = async (db: Db, organizationId: string): Promise<string> => {
  const importId = await seedCsvImport(db, organizationId);
  await db
    .update(salesCsvImports)
    .set({
      status: 'MAPPED',
      columnMapping: { occurredAt: 'occurred_at', posItemName: 'item', quantity: 'qty', unitPrice: 'price' },
    })
    .where(eq(salesCsvImports.id, importId));
  return importId;
};

/**
 * a real `Conversation` — `assistant.getConversation`'s own-resource starting state, and
 * `assistant.ask`'s CONTINUING-an-existing-conversation case (see below). The real risk here is
 * exactly what the design's own "grounding bundle retained for dispute resolution" design creates a
 * NEW incentive to leak: a conversation transcript can carry real cited business figures, so
 * tenant B reading — or, for `assistant.ask`, APPENDING TO — tenant A's conversation by guessed/
 * observed `conversationId` is a genuine data leak/tamper risk, not just an access-control
 * nicety. **A first version of this comment claimed `assistant.ask` had no id-scoped attack
 * surface at all, reasoning it only ever CREATES a conversation — wrong, caught by the registry's
 * own completeness check, not by manual review**: `askInput`'s `conversationId` is a real,
 * optional id-shaped field, and a caller supplying another tenant's real conversationId would be
 * attempting exactly this attack. The router's own `ConversationRepository.findById` (tenant-
 * scoped) already correctly rejects it with a 404 — this entry proves that live, not just trusts
 * the code reading correct.
 */
const seedConversation = async (db: Db, organizationId: string): Promise<string> => {
  const userId = generateId();
  await db.insert(users).values({ id: userId, email: `cross-tenant-probe-conversation-user-${userId}@example.test` });
  const conversationRepository = new ConversationRepository(db, organizationId);
  const { id } = await conversationRepository.create({ userId });
  return id;
};

const seedNotificationRule = async (db: Db, organizationId: string): Promise<string> => {
  const ruleRepository = new NotificationRuleRepository(db, organizationId);
  const { id } = await ruleRepository.create({
    ruleType: 'stock_below_reorder',
    severity: 'HIGH',
    threshold: {},
    recipientRoles: ['MANAGER'],
    channels: ['EMAIL'],
  });
  return id;
};

const seedNotification = async (db: Db, organizationId: string): Promise<string> => {
  const ruleRepository = new NotificationRuleRepository(db, organizationId);
  const { id: ruleId } = await ruleRepository.create({
    ruleType: 'stock_below_reorder',
    severity: 'HIGH',
    threshold: {},
    recipientRoles: ['MANAGER'],
    channels: ['EMAIL'],
  });
  const notificationRepository = new NotificationRepository(db, organizationId);
  const { id } = await notificationRepository.create({
    ruleId,
    severity: 'HIGH',
    title: 'Cross-tenant probe notification',
    body: 'Cross-tenant probe body.',
    dedupKey: `cross-tenant-probe:${generateId()}`,
  });
  return id;
};

export const resourceScopedProcedures: ResourceScopedProcedure[] = [
  {
    path: 'stores.get',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const storeId = generateId();
      await db.insert(stores).values({
        id: storeId,
        organizationId,
        name: `Cross-tenant probe store ${storeId}`,
        timezone: 'America/New_York',
      });
      return storeId;
    },
    buildInput: (resourceId) => ({ id: resourceId }),
  },
  {
    // Team management — found while building the UI catch-up pass. The real risk: tenant B revoking
    // tenant A's real pending invitation by guessing/reusing an invitationId.
    path: 'invitations.revoke',
    type: 'mutation',
    seedResource: seedInvitation,
    buildInput: (resourceId) => ({ invitationId: resourceId }),
  },
  {
    // The real risk: tenant B changing tenant A's real member's role by guessing a membershipId.
    path: 'invitations.updateRole',
    type: 'mutation',
    seedResource: seedMembership,
    buildInput: (resourceId) => ({ membershipId: resourceId, role: 'MANAGER' }),
  },
  {
    // The real risk: tenant B removing tenant A's real member by guessing a membershipId.
    path: 'invitations.removeMember',
    type: 'mutation',
    seedResource: seedMembership,
    buildInput: (resourceId) => ({ membershipId: resourceId }),
  },
  {
    path: 'products.get',
    type: 'query',
    seedResource: seedProduct,
    buildInput: (resourceId) => ({ id: resourceId }),
  },
  {
    // Not a "fetch by id" attack — the risk here is creating a NEW product that REFERENCES
    // another tenant's categoryId. seedResource seeds the referenced category (in tenant A);
    // buildInput builds a real create payload pointing at it. `units` is a global, non-tenant
    // lookup table (see schema comments), so its own connection here is fine — a fixed, stable
    // seeded value ('each'), not per-test-run generated data.
    path: 'products.create',
    type: 'mutation',
    seedResource: seedCategory,
    buildInput: async (resourceId, _organizationId, db) => {
      const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
      if (!eachUnit) {
        throw new Error("Cross-tenant registry: seeded unit 'each' not found — migrations not applied?");
      }
      return {
        sku: `cross-tenant-create-probe-${resourceId}`,
        name: 'Cross-tenant create attempt',
        baseUnitId: eachUnit.id,
        type: 'INGREDIENT',
        categoryId: resourceId,
      };
    },
  },
  {
    path: 'products.update',
    type: 'mutation',
    seedResource: seedProduct,
    buildInput: (resourceId) => ({ id: resourceId, name: 'Cross-tenant update attempt' }),
  },
  {
    // Same shape as products.create's entry: not a fetch-by-id, but a create REFERENCING another
    // tenant's category as its parent.
    path: 'categories.create',
    type: 'mutation',
    seedResource: seedCategory,
    buildInput: (resourceId) => ({ name: 'Cross-tenant create attempt', parentId: resourceId }),
  },
  {
    path: 'recipes.get',
    type: 'query',
    seedResource: seedRecipe,
    buildInput: (resourceId) => ({ recipeGroupId: resourceId }),
  },
  {
    path: 'recipes.cost',
    type: 'query',
    seedResource: seedRecipe,
    buildInput: (resourceId) => ({ recipeGroupId: resourceId }),
  },
  {
    // Same "seed the REFERENCED resource" shape as products.create/categories.create: the risk
    // is a new recipe's PRODUCT component referencing another tenant's productId, not fetching a
    // recipe by id. seedResource seeds a real product in tenant A; buildInput builds a real
    // one-component recipe.create payload pointing at it.
    path: 'recipes.create',
    type: 'mutation',
    seedResource: seedProduct,
    buildInput: async (resourceId, _organizationId, db) => {
      const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
      if (!eachUnit) {
        throw new Error("Cross-tenant registry: seeded unit 'each' not found — migrations not applied?");
      }
      return {
        name: 'Cross-tenant create attempt',
        yieldQuantity: '1',
        yieldUnitId: eachUnit.id,
        components: [
          {
            componentType: 'PRODUCT',
            productId: resourceId,
            quantity: '1',
            unitId: eachUnit.id,
          },
        ],
      };
    },
  },
  {
    path: 'products.requestImageUpload',
    type: 'mutation',
    seedResource: seedProduct,
    buildInput: (resourceId) => ({ productId: resourceId, contentType: 'image/jpeg' }),
  },
  {
    path: 'products.confirmImageUpload',
    type: 'mutation',
    // Uploads a REAL, valid JPEG at the exact key `confirmImageUpload` would look for
    // (buildProductImageKey's format is a pure function of org+product+extension), so the "tenant
    // A can fetch their own resource" positive-path test gets a genuine 200, not an incidental
    // error from a nonexistent object. The primary check the attacker actually hits first is
    // still ProductRepository.findById returning null cross-org, exactly like every other
    // endpoint here — this upload only exists to make the OWN-resource case work end to end.
    seedResource: async (db, organizationId) => {
      const productId = await seedProduct(db, organizationId);
      await ensureBucketExists(storageClient, PRODUCT_IMAGES_BUCKET);
      const key = buildProductImageKey(organizationId, productId, 'jpg');
      const uploadUrl = await createPresignedUploadUrl(storageClient, PRODUCT_IMAGES_BUCKET, key, 'image/jpeg');
      const realJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: realJpegBytes });
      return productId;
    },
    buildInput: (resourceId, organizationId) => ({
      productId: resourceId,
      key: buildProductImageKey(organizationId, resourceId, 'jpg'),
    }),
  },
  {
    // Attacks with tenant A's storeId — assertStoreAccess (canAccessStore) is the FIRST check
    // every inventory endpoint runs, before any product/variant lookup, so this is the
    // real cross-tenant surface being tested here, same shape as stores.get itself.
    path: 'inventory.levels',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    path: 'inventory.movements',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreAndProduct(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      const [variant] = product
        ? await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, product.id))
        : [undefined];
      return { storeId: resourceId, productId: product?.id ?? generateId(), variantId: variant?.id ?? generateId() };
    },
  },
  {
    path: 'inventory.lots',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreAndProduct(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      return { storeId: resourceId, productId: product?.id ?? generateId() };
    },
  },
  {
    path: 'inventory.logWaste',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreProductWithLot(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      const [variant] = product
        ? await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, product.id))
        : [undefined];
      return {
        storeId: resourceId,
        productId: product?.id ?? generateId(),
        variantId: variant?.id ?? generateId(),
        quantity: '1.000000',
        reasonCode: 'SPILLAGE',
      };
    },
  },
  {
    path: 'inventory.logWasteFromLot',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreProductWithLot(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      const [variant] = product
        ? await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, product.id))
        : [undefined];
      const [lot] = product
        ? await db.select({ id: lots.id }).from(lots).where(eq(lots.productId, product.id))
        : [undefined];
      return {
        storeId: resourceId,
        productId: product?.id ?? generateId(),
        variantId: variant?.id ?? generateId(),
        lotId: lot?.id ?? generateId(),
        quantity: '1.000000',
        reasonCode: 'SPILLAGE',
      };
    },
  },
  {
    // createFull's real cross-tenant risk is attacking with tenant A's storeId — but the "own
    // resource" positive-case test requires a genuine 200, which means tenant A needs a REAL
    // product/variant pair to count, not a fake generateId() placeholder (that would 500, a
    // legitimate rejection of a nonexistent product, not proof the store guard works).
    path: 'stocktake.createFull',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreAndProduct(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      const [variant] = product
        ? await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, product.id))
        : [undefined];
      return {
        storeId: resourceId,
        productVariantPairs: [{ productId: product!.id, variantId: variant!.id }],
      };
    },
  },
  {
    // Same reasoning as createFull: the "own resource" case needs a REAL category with a REAL
    // product in it, not a fake id — createCountByCategory throws EmptyCountScopeError (a genuine
    // BAD_REQUEST, not proof of a cross-tenant guard) against a category with nothing in it.
    path: 'stocktake.createByCategory',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId, productId } = await seedStoreAndProduct(db, organizationId);
      const categoryId = await seedCategory(db, organizationId);
      await db.update(products).set({ categoryId }).where(eq(products.id, productId));
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db
        .select({ categoryId: products.categoryId })
        .from(products)
        .where(eq(products.organizationId, organizationId));
      return { storeId: resourceId, categoryId: product!.categoryId! };
    },
  },
  {
    // Same reasoning again, for storage locations.
    path: 'stocktake.createByStorageLocation',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId, productId } = await seedStoreAndProduct(db, organizationId);
      const storageLocationId = generateId();
      await db.insert(storageLocations).values({
        id: storageLocationId,
        organizationId,
        storeId,
        name: `Cross-tenant probe location ${storageLocationId}`,
      });
      await db.update(products).set({ storageLocationId }).where(eq(products.id, productId));
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db
        .select({ storageLocationId: products.storageLocationId })
        .from(products)
        .where(eq(products.organizationId, organizationId));
      return { storeId: resourceId, storageLocationId: product!.storageLocationId! };
    },
  },
  {
    path: 'stocktake.get',
    type: 'query',
    seedResource: seedStockCount,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    path: 'stocktake.start',
    type: 'mutation',
    seedResource: seedStockCount,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    // The "own resource" case needs a count already IN_PROGRESS with every line counted — submit
    // rejects a DRAFT count (wrong status) or an IN_PROGRESS-but-uncounted one (an incomplete
    // count) regardless of who's calling, neither of which is proof the cross-tenant guard works.
    path: 'stocktake.submit',
    type: 'mutation',
    seedResource: seedInProgressStockCountFullyCounted,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    // Same reasoning: approve/reject both need a count already SUBMITTED.
    path: 'stocktake.approve',
    type: 'mutation',
    seedResource: seedSubmittedStockCount,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    path: 'stocktake.reject',
    type: 'mutation',
    seedResource: seedSubmittedStockCount,
    buildInput: (resourceId) => ({ stockCountId: resourceId }),
  },
  {
    path: 'stocktake.enterCount',
    type: 'mutation',
    seedResource: seedInProgressStockCountLine,
    buildInput: (resourceId) => ({ stockCountLineId: resourceId, countedQuantity: '1.000000' }),
  },
  {
    path: 'stocktake.setLineReason',
    type: 'mutation',
    seedResource: seedStockCountLine,
    buildInput: (resourceId) => ({ stockCountLineId: resourceId, reasonCode: 'Cross-tenant probe' }),
  },
  {
    // Same shape as inventory.levels: attacks with tenant A's storeId, the FIRST check
    // syncSquareCatalog's router runs (assertStoreAccess-equivalent) before ever looking at
    // pos_connections. global.fetch is patched (Square host only) so the "own resource" case can
    // reach a genuine 200 without a real Square sandbox app.
    path: 'integrations.syncSquareCatalog',
    type: 'mutation',
    seedResource: seedPosConnection,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // Same cross-tenant surface and same real-vendor-network problem as syncSquareCatalog —
    // seedPosConnection already seeds a real externalLocationId, which syncSquareOrders requires
    // before it will even attempt the (patched) orders/search call.
    path: 'integrations.syncSquareOrders',
    type: 'mutation',
    seedResource: seedPosConnection,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // same store-scoped mutation shape as syncSquareOrders — assertStoreAccess-equivalent
    // check runs before pos_connections is ever looked at, same patched-fetch approach.
    path: 'integrations.reconcileSquareOrders',
    type: 'mutation',
    seedResource: seedPosConnection,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // requestUpload is store-scoped, not importId-scoped (no import row exists yet at this
    // point in the flow) — same store-ownership check shape as every other store-scoped mutation.
    path: 'csvImport.requestUpload',
    type: 'mutation',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // confirmUpload checks BOTH storeId ownership AND that the given key is prefixed with the
    // caller's own org — attacking with tenant A's storeId (this entry's own resourceId) already
    // exercises the FIRST, primary check this runner targets. A real CSV object is uploaded at a
    // key deterministically derived from `resourceId` (the storeId) itself, so `buildInput` — which
    // only receives `resourceId`, not any extra state from `seedResource` — can reconstruct the
    // identical key, matching `products.confirmImageUpload`'s own real-JPEG precedent so the
    // OWN-resource case reaches a genuine 200.
    path: 'csvImport.confirmUpload',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const storeId = await seedStore(db, organizationId);
      await ensureBucketExists(storageClient, SALES_CSV_IMPORTS_BUCKET);
      // Not seedCsvImport here — confirmUpload is the procedure that INSERTS the row; a real
      // pre-existing row would collide. Only the object storage side needs to exist ahead of time,
      // at a key this entry's own buildInput can deterministically reconstruct from storeId alone.
      const key = buildCsvImportKey(organizationId, storeId);
      const uploadUrl = await createPresignedUploadUrl(storageClient, SALES_CSV_IMPORTS_BUCKET, key, 'text/csv');
      await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: CROSS_TENANT_PROBE_CSV });
      return storeId;
    },
    buildInput: (resourceId, organizationId) => ({
      storeId: resourceId,
      key: buildCsvImportKey(organizationId, resourceId),
    }),
  },
  {
    path: 'csvImport.get',
    type: 'query',
    seedResource: seedCsvImport,
    buildInput: (resourceId) => ({ importId: resourceId }),
  },
  {
    path: 'csvImport.submitColumnMapping',
    type: 'mutation',
    seedResource: seedCsvImport,
    buildInput: (resourceId) => ({
      importId: resourceId,
      columnMapping: { occurredAt: 'occurred_at', posItemName: 'item', quantity: 'qty', unitPrice: 'price' },
    }),
  },
  {
    path: 'csvImport.commit',
    type: 'mutation',
    seedResource: seedMappedCsvImport,
    buildInput: (resourceId) => ({ importId: resourceId }),
  },
  {
    // Store-scoped, same shape as inventory.levels/csvImport.requestUpload — attacks with tenant
    // A's storeId, the FIRST check listUnmapped's router runs.
    path: 'posItems.listUnmapped',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedPosItem(db, organizationId);
      return storeId;
    },
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // Id-scoped, not store-scoped — the risk is tenant B mapping tenant A's real pos_items row.
    // Own-resource case needs a real menuItemId too, so buildInput seeds one fresh via `db`.
    path: 'posItems.mapToMenuItem',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { posItemId } = await seedPosItem(db, organizationId);
      return posItemId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const menuItemId = await seedMenuItem(db, organizationId);
      return { id: resourceId, menuItemId };
    },
  },
  {
    path: 'posItems.ignore',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { posItemId } = await seedPosItem(db, organizationId);
      return posItemId;
    },
    buildInput: (resourceId) => ({ id: resourceId }),
  },
  {
    // Store-scoped, same shape as inventory.levels — the store-ownership check is the first thing
    // the dashboard runs, before any metric is computed.
    path: 'dashboard.summary',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId, days: 30 }),
  },
  {
    // same store-scoped shape as dashboard.summary — the manager dashboard's own
    // store-ownership check runs first, before any of its metrics/repository queries.
    path: 'dashboard.managerSummary',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId, days: 30 }),
  },
  {
    // same store-scoped shape as dashboard.summary — the real risk is tenant B passing
    // tenant A's real storeId to read its source rows behind a figure.
    path: 'dashboard.drillThrough',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId, figure: 'net_revenue', from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), to: new Date() }),
  },
  {
    // requestUpload is store-scoped, not documentId-scoped (no document row exists yet at this
    // point in the flow) — same shape as csvImport.requestUpload.
    path: 'documents.requestUpload',
    type: 'mutation',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // Store-scoped confirmUpload attack, same shape as csvImport.confirmUpload — the FIRST check
    // the procedure runs is store ownership, before the key-prefix check even matters.
    path: 'documents.confirmUpload',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const storeId = await seedStore(db, organizationId);
      await ensureBucketExists(storageClient, DOCUMENTS_BUCKET);
      // Not seedDocument here — confirmUpload is the procedure that INSERTS the row; a real
      // pre-existing row would collide. Only the object storage side needs to exist ahead of time,
      // at a key this entry's own buildInput can deterministically reconstruct from storeId alone.
      const key = buildDocumentKey(organizationId, storeId, 'pdf');
      const uploadUrl = await createPresignedUploadUrl(storageClient, DOCUMENTS_BUCKET, key, 'application/pdf');
      await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: CROSS_TENANT_PROBE_PDF });
      return storeId;
    },
    buildInput: (resourceId, organizationId) => ({
      storeId: resourceId,
      key: buildDocumentKey(organizationId, resourceId, 'pdf'),
    }),
  },
  {
    path: 'documents.get',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { documentId } = await seedDocument(db, organizationId);
      return documentId;
    },
    buildInput: (resourceId) => ({ documentId: resourceId }),
  },
  {
    // Store-scoped, same shape as dashboard.summary/inventory.levels.
    path: 'documents.list',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedDocument(db, organizationId);
      return storeId;
    },
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // same store-scoped shape as documents.list.
    path: 'documents.search',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedDocument(db, organizationId);
      return storeId;
    },
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    path: 'documents.getForReview',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { documentId } = await seedDocumentAwaitingReview(db, organizationId);
      return documentId;
    },
    buildInput: (resourceId) => ({ documentId: resourceId }),
  },
  {
    path: 'documents.approve',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { documentId } = await seedDocumentAwaitingReview(db, organizationId);
      return documentId;
    },
    buildInput: (resourceId) => ({ documentId: resourceId }),
  },
  {
    path: 'documents.reject',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { documentId } = await seedDocumentAwaitingReview(db, organizationId);
      return documentId;
    },
    buildInput: (resourceId) => ({ documentId: resourceId }),
  },
  {
    // buildInput looks up a real product belonging to `organizationId` fresh — the runner
    // always passes tenant A's organizationId here (see cross-tenant.test.ts), so this is a real
    // product to map to in BOTH the attack (tenant B calling with tenant A's documentId) and the
    // own-resource (tenant A calling with their own documentId) cases.
    path: 'documents.confirmLineMapping',
    type: 'mutation',
    seedResource: seedDocumentAwaitingReviewWithLine,
    buildInput: async (resourceId, organizationId, db) => {
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
      if (!product) {
        throw new Error('Cross-tenant registry: documents.confirmLineMapping expected a seeded product, found none.');
      }
      return { documentId: resourceId, lineIndex: 0, productId: product.id };
    },
  },
  {
    path: 'documents.getLinks',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { documentId } = await seedDocumentAwaitingReview(db, organizationId);
      return documentId;
    },
    buildInput: (resourceId) => ({ documentId: resourceId }),
  },
  {
    // Store-scoped, same shape as inventory.levels/dashboard.summary — the store-ownership check
    // is the first thing reorderSuggestions' router runs, before findReorderSuggestions is called.
    path: 'purchaseOrders.reorderSuggestions',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // Store-scoped, same shape as reorderSuggestions above — the store-ownership check is the
    // first thing the list router runs. `supplierId`/`cursor` are also id-shaped but only ever
    // FILTER rows already org-scoped by the repository; the storeId is the actual attack surface.
    path: 'purchaseOrders.list',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // Store-scoped (creating a PO needs a real storeId + supplierId, both org-owned) — attacks
    // with tenant A's storeId, the first check the router runs before ever touching supplierId.
    path: 'purchaseOrders.create',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { storeId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
      return storeId;
    },
    buildInput: async (resourceId, organizationId, db) => {
      const [supplier] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.organizationId, organizationId));
      return { storeId: resourceId, supplierId: supplier!.id, poNumber: `PO-${generateId()}` };
    },
  },
  {
    // Id-scoped, not store-scoped — the real risk is tenant B adding a line to tenant A's real PO.
    path: 'purchaseOrders.addLine',
    type: 'mutation',
    seedResource: seedDraftPurchaseOrder,
    buildInput: async (resourceId, organizationId, db) => {
      const [sp] = await db.select({ id: supplierProducts.id, productId: supplierProducts.productId }).from(supplierProducts).where(eq(supplierProducts.organizationId, organizationId));
      return { purchaseOrderId: resourceId, supplierProductId: sp!.id, productId: sp!.productId, quantityOrderUnits: '1', conversionToBase: '1', unitPrice: '5.00', lineNumber: 1 };
    },
  },
  {
    path: 'purchaseOrders.get',
    type: 'query',
    seedResource: seedDraftPurchaseOrder,
    buildInput: (resourceId) => ({ purchaseOrderId: resourceId }),
  },
  {
    // The own-resource case needs a real DRAFT PO at version 1 — submit rejects any other status
    // regardless of who's calling, which would be a false negative for the cross-tenant guard.
    path: 'purchaseOrders.submit',
    type: 'mutation',
    seedResource: seedDraftPurchaseOrderWithLine,
    buildInput: (resourceId) => ({ purchaseOrderId: resourceId, expectedVersion: 1 }),
  },
  {
    // The own-resource case needs a real PENDING_APPROVAL PO at version 2 (create=v1, submit=v2).
    path: 'purchaseOrders.approve',
    type: 'mutation',
    seedResource: seedPendingApprovalPurchaseOrder,
    buildInput: (resourceId) => ({ purchaseOrderId: resourceId, expectedVersion: 2 }),
  },
  {
    path: 'purchaseOrders.reject',
    type: 'mutation',
    seedResource: seedPendingApprovalPurchaseOrder,
    buildInput: (resourceId) => ({ purchaseOrderId: resourceId, expectedVersion: 2 }),
  },
  {
    // The own-resource case needs a real APPROVED PO at version 3 (create=v1, submit=v2, approve=v3).
    path: 'purchaseOrders.send',
    type: 'mutation',
    seedResource: seedApprovedPurchaseOrder,
    buildInput: (resourceId) => ({ purchaseOrderId: resourceId, expectedVersion: 3 }),
  },
  {
    // id-scoped by purchaseOrderId — a DRAFT PO (never sent) is a valid own-resource case,
    // since `getPdfUrl` must return `{ url: null }` rather than error for one (I7), same as `get`.
    path: 'purchaseOrders.getPdfUrl',
    type: 'query',
    seedResource: seedDraftPurchaseOrder,
    buildInput: (resourceId) => ({ purchaseOrderId: resourceId }),
  },
  {
    path: 'purchaseOrders.cancel',
    type: 'mutation',
    seedResource: seedDraftPurchaseOrder,
    buildInput: (resourceId) => ({ purchaseOrderId: resourceId, expectedVersion: 1 }),
  },
  {
    // id-scoped by purchaseOrderLineId — the real risk is tenant B posting a receipt (and
    // thereby a real lot + RECEIPT movement + PO state transition) against tenant A's real PO line.
    // `buildInput` re-derives storeId/purchaseOrderId/supplierId from the SEEDED line itself (via a
    // real join), not the calling org — attacking with tenant A's line must fail regardless of what
    // other fields the request carries.
    path: 'goodsReceipts.confirmReceipt',
    type: 'mutation',
    seedResource: seedSentPurchaseOrderWithLine,
    buildInput: async (resourceId, _organizationId, db) => {
      const [line] = await db
        .select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId, storeId: purchaseOrders.storeId, supplierId: purchaseOrders.supplierId })
        .from(purchaseOrderLines)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
        .where(eq(purchaseOrderLines.id, resourceId));
      if (!line) {
        throw new Error('Cross-tenant registry: goodsReceipts.confirmReceipt could not resolve its seeded PO line.');
      }
      return {
        storeId: line.storeId,
        purchaseOrderId: line.purchaseOrderId,
        supplierId: line.supplierId,
        receivedAt: new Date().toISOString(),
        lines: [{ purchaseOrderLineId: resourceId, receivedQuantityBaseUnits: '1', lineNumber: 1 }],
      };
    },
  },
  {
    path: 'goodsReceipts.get',
    type: 'query',
    seedResource: seedGoodsReceipt,
    buildInput: (resourceId) => ({ goodsReceiptId: resourceId }),
  },
  {
    // id-scoped by goodsReceiptLineId — the real risk is tenant B obtaining a real presigned
    // upload URL for tenant A's receipt line (a genuine information/write-surface leak even though
    // the URL alone doesn't touch photoObjectKeys until confirmPhotoUpload).
    path: 'goodsReceipts.requestPhotoUpload',
    type: 'mutation',
    seedResource: async (db, organizationId) => (await seedGoodsReceiptAndLine(db, organizationId)).goodsReceiptLineId,
    buildInput: (resourceId) => ({ goodsReceiptLineId: resourceId, contentType: 'image/jpeg' as const }),
  },
  {
    // Id-scoped by goodsReceiptLineId — the real risk is tenant B appending a photo key onto tenant
    // A's real receipt line. Uploads a REAL, valid JPEG at the exact key `confirmPhotoUpload` would
    // look for (matching `products.confirmImageUpload`'s own precedent exactly), so the OWN-resource
    // positive case gets a genuine 200, not an incidental S3-404. The primary check tenant B actually
    // hits first is still `GoodsReceiptRepository.findLineById` returning null cross-org.
    path: 'goodsReceipts.confirmPhotoUpload',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { goodsReceiptLineId } = await seedGoodsReceiptAndLine(db, organizationId);
      await ensureBucketExists(storageClient, GOODS_RECEIPT_PHOTOS_BUCKET);
      const key = buildGoodsReceiptLinePhotoKey(organizationId, goodsReceiptLineId, 'probe', 'jpg');
      const uploadUrl = await createPresignedUploadUrl(storageClient, GOODS_RECEIPT_PHOTOS_BUCKET, key, 'image/jpeg');
      const realJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: realJpegBytes });
      return goodsReceiptLineId;
    },
    buildInput: (resourceId, organizationId) => ({
      goodsReceiptLineId: resourceId,
      key: buildGoodsReceiptLinePhotoKey(organizationId, resourceId, 'probe', 'jpg'),
    }),
  },
  {
    // Id-scoped by supplierId, not store-scoped — the real risk is tenant B reading tenant A's
    // real supplier-product mappings (pack sizes, confirmed SKUs) via a guessed/observed supplierId.
    path: 'suppliers.confirmedProducts',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { supplierId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
      return supplierId;
    },
    buildInput: (resourceId) => ({ supplierId: resourceId }),
  },
  {
    path: 'suppliers.get',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { supplierId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
      return supplierId;
    },
    buildInput: (resourceId) => ({ id: resourceId }),
  },
  {
    path: 'suppliers.update',
    type: 'mutation',
    seedResource: async (db, organizationId) => {
      const { supplierId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
      return supplierId;
    },
    buildInput: (resourceId) => ({ id: resourceId, name: 'Renamed by cross-tenant probe' }),
  },
  {
    // Id-scoped by supplierId — the real risk is tenant B reading tenant A's real supplier
    // performance figures (fill rate, price variance) via a guessed/observed supplierId.
    path: 'supplierPerformance.components',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { supplierId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
      return supplierId;
    },
    buildInput: (resourceId) => ({ supplierId: resourceId }),
  },
  {
    path: 'supplierPerformance.events',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { supplierId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
      return supplierId;
    },
    buildInput: (resourceId) => ({ supplierId: resourceId }),
  },
  {
    path: 'supplierPerformance.trend',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { supplierId } = await seedStoreSupplierAndSupplierProduct(db, organizationId);
      return supplierId;
    },
    buildInput: (resourceId) => ({ supplierId: resourceId }),
  },
  {
    path: 'invoiceMatches.get',
    type: 'query',
    seedResource: async (db, organizationId) => (await seedInvoiceMatch(db, organizationId)).invoiceMatchId,
    buildInput: (resourceId) => ({ invoiceMatchId: resourceId }),
  },
  {
    // Id-scoped by documentId, not the match id — the real risk is tenant B reading tenant A's
    // match result by guessing/observing a documentId (e.g. from documents.list).
    path: 'invoiceMatches.getByDocument',
    type: 'query',
    seedResource: async (db, organizationId) => {
      const { invoiceMatchId } = await seedInvoiceMatch(db, organizationId);
      const repo = new InvoiceMatchRepository(db, organizationId);
      const match = await repo.findById(invoiceMatchId);
      return match!.documentId;
    },
    buildInput: (resourceId) => ({ documentId: resourceId }),
  },
  {
    // Store-scoped, same shape as dashboard.summary/inventory.levels — the real risk is tenant B
    // passing tenant A's real storeId to read its pending variance queue.
    path: 'invoiceMatches.pending',
    type: 'query',
    seedResource: async (db, organizationId) => (await seedInvoiceMatch(db, organizationId)).storeId,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // the real risk is tenant B resolving tenant A's real invoice match (a genuine
    // financial-control action, not just a read) via a guessed/observed invoiceMatchId.
    path: 'invoiceMatches.resolve',
    type: 'mutation',
    seedResource: async (db, organizationId) => (await seedInvoiceMatch(db, organizationId)).invoiceMatchId,
    buildInput: (resourceId) => ({ invoiceMatchId: resourceId, resolutionNotes: 'Cross-tenant probe resolution note.' }),
  },
  {
    // tenant B reading tenant A's real conversation transcript (which can carry real cited
    // business figures via the grounding bundle) by guessed/observed conversationId.
    path: 'assistant.getConversation',
    type: 'query',
    seedResource: async (db, organizationId) => seedConversation(db, organizationId),
    buildInput: (resourceId) => ({ conversationId: resourceId }),
  },
  {
    // tenant B APPENDING a message to tenant A's real conversation by guessed/observed
    // conversationId — a genuinely different risk shape from the read-only entry above (tamper,
    // not just leak), on the SAME underlying resource. `assistant.ask` calling out to a real
    // Gemini API mid-request is a real, accepted cost of this entry (matching
    // `integrations.syncSquareCatalog`'s own precedent for a registry entry that calls a real
    // external vendor) — no card/cost risk since this project's one GEMINI_API_KEY is already
    // free-tier.
    path: 'assistant.ask',
    type: 'mutation',
    seedResource: async (db, organizationId) => seedConversation(db, organizationId),
    buildInput: (resourceId) => ({ conversationId: resourceId, question: 'Cross-tenant probe question — what is my net revenue?' }),
  },
  {
    // the daily briefing is store-scoped, the same shape as dashboard.summary — tenant B
    // must not be able to read tenant A's exception set (which carries real cited money figures)
    // by supplying tenant A's storeId. No live model call is involved in the rejection path: the
    // store-ownership check runs long before any narration.
    path: 'assistant.briefing',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // the notification centre's real list — tenant B must not be able to read tenant A's
    // notifications (which carry real cited money figures via dollarImpact/body) by supplying
    // tenant A's storeId. Same two-layer store check as assistant.briefing.
    path: 'notifications.list',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    path: 'notifications.unreadCount',
    type: 'query',
    seedResource: seedStore,
    buildInput: (resourceId) => ({ storeId: resourceId }),
  },
  {
    // tenant B marking tenant A's real notification read by guessed/observed id — a leak-adjacent
    // tamper: it would silently clear tenant A's own unread badge without tenant A ever seeing it.
    path: 'notifications.markRead',
    type: 'mutation',
    seedResource: seedNotification,
    buildInput: (resourceId) => ({ id: resourceId }),
  },
  {
    // tenant B marking tenant A's real notification "acted on" by guessed/observed id — would
    // corrupt future action-rate tracking with a fabricated action tenant A never took.
    path: 'notifications.markActed',
    type: 'mutation',
    seedResource: seedNotification,
    buildInput: (resourceId) => ({ id: resourceId }),
  },
  {
    // Tenant B silently reconfiguring tenant A's real alert rule (severity/recipients/
    // channels) by guessed/observed ruleId — would corrupt which of tenant A's own staff actually
    // gets notified about a real business condition, a genuinely dangerous tamper, not just a leak.
    path: 'notifications.updateRuleTuning',
    type: 'mutation',
    seedResource: seedNotificationRule,
    buildInput: (resourceId) => ({
      ruleId: resourceId,
      ruleType: 'stock_below_reorder',
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    }),
  },
];
