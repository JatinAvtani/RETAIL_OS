import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import {
  auditLogs,
  categories,
  lots,
  organizations,
  outboxEvents,
  productVariants,
  products,
  stockCountLines,
  stockCounts,
  stockLevels,
  stockMovements,
  storageLocations,
  stores,
  units,
  users,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import {
  EmptyCountScopeError,
  InvalidStockCountTransitionError,
  MissingVarianceReasonError,
  StockCountService,
} from './stock-count-service';
import { UnknownCostSurplusError } from './movement-service';
import { MovementService } from './movement-service';
import { LotRepository } from './lot-repository';
import { ProductRepository } from './product-repository';
import { CategoryRepository } from './category-repository';
import { StorageLocationRepository } from './storage-location-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('StockCountService', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let unitId: string;
  let productId: string;
  let variantId: string;
  let userId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Stock Count Test Org',
      slug: `stock-count-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const existingUnit = await adminDb.select().from(units).where(eq(units.code, 'g'));
    unitId = existingUnit[0]?.id ?? generateId();
    if (!existingUnit[0]) {
      await adminDb.insert(units).values({ id: unitId, code: 'g', dimension: 'MASS', isBase: true });
    }

    const productRepo = new ProductRepository(createScopedDb(client), organizationId);
    const product = await productRepo.create({
      id: generateId(),
      sku: `SKU-${generateId()}`,
      name: 'Flour',
      baseUnitId: unitId,
      type: 'INGREDIENT',
    });
    productId = product.id;
    variantId = (await productRepo.findVariants(productId))[0]!.id;

    userId = generateId();
    await adminDb.insert(users).values({ id: userId, email: `stock-count-${userId}@example.test` });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stockCountLines).where(eq(stockCountLines.organizationId, organizationId));
    await adminDb.delete(stockCounts).where(eq(stockCounts.organizationId, organizationId));
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    await adminDb.delete(lots).where(eq(lots.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(productVariants).where(eq(productVariants.productId, productId));
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await adminDb.delete(users).where(eq(users.id, userId));
    await client.end();
    await adminClient.end();
  });

  it('freezes theoretical_quantity_t0 at startCount and does NOT change it even if stock_levels changes afterward (the T0 subtlety, spec 05 §5.1.4)', async () => {
    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({
      storeId,
      scope: 'full',
      productVariantPairs: [{ productId, variantId }],
    });
    await service.startCount(count.id);

    const linesAtT0 = await service.findLines(count.id);
    expect(linesAtT0[0]?.theoreticalQuantityT0).toBe('100.000000');

    // A real sale happens DURING the count window, after T0 — this must NOT retroactively change
    // the frozen snapshot (that's exactly the phantom-variance bug the T0 snapshot exists to
    // prevent).
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-10.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });

    const linesAfterSale = await service.findLines(count.id);
    expect(linesAfterSale[0]?.theoreticalQuantityT0).toBe('100.000000');
  });

  it('a physical count matching the frozen T0 snapshot (ignoring a real post-T0 sale) produces ZERO variance — proving the sale is correctly excluded, not folded in as phantom shrinkage', async () => {
    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;

    // A real sale during the count window — this changes stock_levels.quantity to 90.
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-10.000000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'pos-sync',
    });

    // Staff physically counts exactly 100 units (impossible in reality if the sale actually
    // shipped stock out the door mid-count, but this is testing the SYSTEM's math specifically):
    // if variance were computed against a LIVE theoretical (which the post-T0 sale changed to 90),
    // counting 100 would show a false +10 surplus — a phantom variance caused entirely by the
    // sale, not any real discrepancy. Because theoretical_t0 stays frozen at the ORIGINAL 100,
    // variance is genuinely zero — proving the post-T0 sale was correctly excluded from the
    // comparison, exactly the T0-snapshot subtlety spec 05 §5.1.4 exists to guarantee.
    await service.enterCount(lineId, '100.000000', userId);
    const submitted = await service.submitCount(count.id, userId);
    expect(submitted.status).toBe('SUBMITTED');

    const line = (await service.findLines(count.id))[0]!;
    expect(line.varianceQuantity).toBe('0.000000');
  });

  it('a real shortfall is reconciled by drawing down existing ACTIVE lots FEFO-style, at their own cost, and posts a COUNT_ADJUSTMENT movement', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    const earlierExpiry = await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date('2026-08-01T00:00:00Z'),
      expiryDate: '2026-08-10',
      initialQuantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });

    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date('2026-08-01T00:00:00Z'),
      sourceType: 'manual',
    });

    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;

    // Counted 85, theoretical was 100 — a real shortfall of 15 (15%, above the 10% threshold, so
    // a reason code is required before approval — this test is about lot reconciliation, not
    // threshold enforcement, which has its own dedicated tests below).
    await service.enterCount(lineId, '85.000000', userId);
    await service.submitCount(count.id, userId);

    const lineBeforeApproval = (await service.findLines(count.id))[0]!;
    expect(lineBeforeApproval.varianceQuantity).toBe('-15.000000');

    const adminDb2 = drizzle(adminClient, { schema });
    await adminDb2.update(stockCountLines).set({ reasonCode: 'Spillage during prep' }).where(eq(stockCountLines.id, lineId));

    const approved = await service.approveCount(count.id, userId);
    expect(approved.status).toBe('APPROVED');

    const updatedLot = await lotRepo.findById(earlierExpiry.id);
    expect(updatedLot?.remainingQuantity).toBe('85.000000');

    const adminDb = drizzle(adminClient, { schema });
    const movements = await adminDb
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.organizationId, organizationId));
    const adjustment = movements.find((m) => m.movementType === 'COUNT_ADJUSTMENT');
    expect(adjustment?.quantity).toBe('-15.000000');
    expect(adjustment?.unitCost).toBe('2.0000');
  });

  it('a real surplus creates a NEW adjustment lot at the frozen t0UnitCost and posts a COUNT_ADJUSTMENT movement', async () => {
    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '50.000000',
      unitCost: '3.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;

    // Counted 60, theoretical was 50 — a real surplus of 10 (20%, above the 10% threshold, so a
    // reason code is required before approval).
    await service.enterCount(lineId, '60.000000', userId);
    await service.submitCount(count.id, userId);
    const adminDbPre = drizzle(adminClient, { schema });
    await adminDbPre.update(stockCountLines).set({ reasonCode: 'Found unrecorded receipt' }).where(eq(stockCountLines.id, lineId));
    await service.approveCount(count.id, userId);

    const adminDb = drizzle(adminClient, { schema });
    const newLots = await adminDb
      .select()
      .from(lots)
      .where(eq(lots.organizationId, organizationId));
    // The setup RECEIPT was posted via MovementService.postMovement directly (not
    // LotRepository.receive), which never creates a lots row on its own — so the only lot in
    // existence is the NEW adjustment lot the surplus reconciliation created.
    expect(newLots).toHaveLength(1);
    const adjustmentLot = newLots.find((l) => Number(l.initialQuantity) === 10);
    expect(adjustmentLot?.unitCost).toBe('3.0000');

    const movements = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    const adjustment = movements.find((m) => m.movementType === 'COUNT_ADJUSTMENT');
    expect(adjustment?.quantity).toBe('10.000000');
    expect(adjustment?.lotId).toBe(adjustmentLot?.id);
  });

  it('approveCount rejects a surplus with no known cost basis (I7) rather than guessing $0.00', async () => {
    // No RECEIPT ever posted for this product/variant — stock_levels has no row, so avgUnitCost
    // (and therefore t0UnitCost) is genuinely unknown, yet a physical count still finds stock.
    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;

    await service.enterCount(lineId, '5.000000', userId);
    await service.submitCount(count.id, userId);
    // A 100%-magnitude variance also requires a reason code (the threshold check) — supply one so
    // this test isolates the UNKNOWN-COST rejection specifically, not the threshold rejection.
    const adminDbReason = drizzle(adminClient, { schema });
    await adminDbReason.update(stockCountLines).set({ reasonCode: 'Found unrecorded stock' }).where(eq(stockCountLines.id, lineId));

    await expect(service.approveCount(count.id, userId)).rejects.toThrow(UnknownCostSurplusError);

    // No movement or lot was created — the rejection happened before any writes.
    const adminDb = drizzle(adminClient, { schema });
    const movements = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    expect(movements).toHaveLength(0);
  });

  it('a variance exceeding the 10% threshold blocks approval without a reason code, then succeeds once one is recorded', async () => {
    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });
    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    // Need a real lot for the shortfall to draw from.
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '100.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });

    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;

    // Counted 80 vs theoretical 100 — a 20% shortfall, well above the 10% threshold.
    await service.enterCount(lineId, '80.000000', userId);
    await service.submitCount(count.id, userId);

    await expect(service.approveCount(count.id, userId)).rejects.toThrow(MissingVarianceReasonError);

    // Record a reason code directly (the repository doesn't expose a dedicated setReasonCode
    // method yet — a real gap for a future task's UI wiring, so this test writes it via the raw
    // table object, proving the column itself is what approveCount actually checks).
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.update(stockCountLines).set({ reasonCode: 'Damaged in walk-in cooler' }).where(eq(stockCountLines.id, lineId));

    const approved = await service.approveCount(count.id, userId);
    expect(approved.status).toBe('APPROVED');
  });

  it('a variance under the 10% threshold does NOT require a reason code', async () => {
    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });
    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '100.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });

    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;

    // Counted 97 vs theoretical 100 — a 3% shortfall, under the threshold.
    await service.enterCount(lineId, '97.000000', userId);
    await service.submitCount(count.id, userId);

    const approved = await service.approveCount(count.id, userId);
    expect(approved.status).toBe('APPROVED');
  });

  it('rejects invalid state transitions with a typed error (e.g. approving a count that is still DRAFT)', async () => {
    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });

    await expect(service.approveCount(count.id, userId)).rejects.toThrow(InvalidStockCountTransitionError);
    await expect(service.submitCount(count.id, userId)).rejects.toThrow(InvalidStockCountTransitionError);
  });

  it('submitCount rejects a count with an uncounted line rather than treating it as zero variance', async () => {
    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    // Deliberately never calling enterCount.

    await expect(service.submitCount(count.id, userId)).rejects.toThrow();
  });

  it('rejectCount discards a submitted count without posting any movements', async () => {
    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '20.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const service = new StockCountService(createScopedDb(client), organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;
    await service.enterCount(lineId, '15.000000', userId);
    await service.submitCount(count.id, userId);

    const rejected = await service.rejectCount(count.id, userId);
    expect(rejected.status).toBe('REJECTED');

    const adminDb = drizzle(adminClient, { schema });
    const movements = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    // Only the original RECEIPT — no COUNT_ADJUSTMENT was ever posted for a rejected count.
    expect(movements.every((m) => m.movementType !== 'COUNT_ADJUSTMENT')).toBe(true);
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new StockCountService(createScopedDb(client), '')).toThrow();
  });

  describe('scoped count creation (005-12)', () => {
    let categoryId: string;
    let storageLocationId: string;
    let scopedProductId: string;
    let scopedVariantId: string;
    let unscopedProductId: string;

    beforeAll(async () => {
      const categoryRepo = new CategoryRepository(createScopedDb(client), organizationId);
      const category = await categoryRepo.create({ id: generateId(), name: 'Dairy' });
      categoryId = category.id;

      const storageLocationRepo = new StorageLocationRepository(createScopedDb(client), organizationId);
      const location = await storageLocationRepo.create({ id: generateId(), storeId, name: 'Walk-in Fridge' });
      storageLocationId = location.id;

      const productRepo = new ProductRepository(createScopedDb(client), organizationId);
      const scopedProduct = await productRepo.create({
        id: generateId(),
        sku: `SKU-SCOPED-${generateId()}`,
        name: 'Cheese',
        baseUnitId: unitId,
        type: 'INGREDIENT',
        categoryId,
      });
      scopedProductId = scopedProduct.id;
      scopedVariantId = (await productRepo.findVariants(scopedProductId))[0]!.id;
      // storageLocationId isn't settable via update() (deliberately excluded from that method's
      // input) — set it directly via the raw table object, matching this test's narrow need.
      const adminDbSetup = drizzle(adminClient, { schema });
      await adminDbSetup.update(products).set({ storageLocationId }).where(eq(products.id, scopedProductId));

      const unscopedProduct = await productRepo.create({
        id: generateId(),
        sku: `SKU-UNSCOPED-${generateId()}`,
        name: 'Ketchup',
        baseUnitId: unitId,
        type: 'INGREDIENT',
      });
      unscopedProductId = unscopedProduct.id;
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(productVariants).where(eq(productVariants.productId, scopedProductId));
      await adminDb.delete(productVariants).where(eq(productVariants.productId, unscopedProductId));
      await adminDb.delete(products).where(eq(products.id, scopedProductId));
      await adminDb.delete(products).where(eq(products.id, unscopedProductId));
      await adminDb.delete(storageLocations).where(eq(storageLocations.id, storageLocationId));
      await adminDb.delete(categories).where(eq(categories.id, categoryId));
    });

    it('createCountByCategory includes only products in that category, excluding the unscoped product', async () => {
      const service = new StockCountService(createScopedDb(client), organizationId);
      const count = await service.createCountByCategory({ storeId, categoryId, createdByUserId: userId });

      expect(count.scope).toBe(`category:${categoryId}`);
      const lines = await service.findLines(count.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.productId).toBe(scopedProductId);
      expect(lines[0]?.variantId).toBe(scopedVariantId);
    });

    it('createCountByStorageLocation includes only products at that location', async () => {
      const service = new StockCountService(createScopedDb(client), organizationId);
      const count = await service.createCountByStorageLocation({ storeId, storageLocationId, createdByUserId: userId });

      expect(count.scope).toBe(`storageLocation:${storageLocationId}`);
      const lines = await service.findLines(count.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.productId).toBe(scopedProductId);
    });

    it('a scoped count runs through the exact same state machine as a full count — startCount still freezes T0', async () => {
      const movementService = new MovementService(createScopedDb(client), organizationId);
      await movementService.postMovement({
        storeId,
        productId: scopedProductId,
        variantId: scopedVariantId,
        movementType: 'RECEIPT',
        quantity: '40.000000',
        unitCost: '5.0000',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'manual',
      });

      const service = new StockCountService(createScopedDb(client), organizationId);
      const count = await service.createCountByCategory({ storeId, categoryId });
      const started = await service.startCount(count.id);
      expect(started.status).toBe('IN_PROGRESS');

      const lines = await service.findLines(count.id);
      expect(lines[0]?.theoreticalQuantityT0).toBe('40.000000');
    });

    it('createCountByCategory throws EmptyCountScopeError for a category with no products at all, rather than creating an empty count', async () => {
      const categoryRepo = new CategoryRepository(createScopedDb(client), organizationId);
      const emptyCategory = await categoryRepo.create({ id: generateId(), name: 'Empty Category' });

      const service = new StockCountService(createScopedDb(client), organizationId);
      await expect(service.createCountByCategory({ storeId, categoryId: emptyCategory.id })).rejects.toThrow(EmptyCountScopeError);

      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(categories).where(eq(categories.id, emptyCategory.id));
    });
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;
    let productAId: string;
    let variantAId: string;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
      const adminDb = drizzle(adminClient, { schema });
      const existingUnit = await adminDb.select().from(units).where(eq(units.code, 'g'));
      const unitIdForCrossTenant = existingUnit[0]!.id;

      const repoA = new ProductRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const productA = await repoA.create({
        id: generateId(),
        sku: `SKU-CT-${generateId()}`,
        name: 'Cross Tenant Flour',
        baseUnitId: unitIdForCrossTenant,
        type: 'INGREDIENT',
      });
      productAId = productA.id;
      variantAId = (await repoA.findVariants(productAId))[0]!.id;
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(stockCountLines).where(eq(stockCountLines.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(stockCounts).where(eq(stockCounts.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(productVariants).where(eq(productVariants.productId, productAId));
      await adminDb.delete(products).where(eq(products.id, productAId));
      await fixture.cleanup();
    });

    it('tenant B cannot read or act on tenant A\'s stock count', async () => {
      const serviceA = new StockCountService(createScopedDb(client), fixture.tenantA.organizationId);
      const count = await serviceA.createCount({
        storeId: fixture.tenantA.storeId,
        scope: 'full',
        productVariantPairs: [{ productId: productAId, variantId: variantAId }],
      });

      const serviceB = new StockCountService(createScopedDb(client), fixture.tenantB.organizationId);
      const foundByB = await serviceB.findById(count.id);
      expect(foundByB).toBeNull();

      await expect(serviceB.startCount(count.id)).rejects.toThrow();

      // Confirmed still genuinely DRAFT for tenant A afterward — tenant B's attempt had no effect.
      const stillDraft = await serviceA.findById(count.id);
      expect(stillDraft?.status).toBe('DRAFT');
    });
  });
});
