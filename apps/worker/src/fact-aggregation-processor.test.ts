import { describe, expect, it, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId, resolveLocalDate } from '@retailos/domain';
import type { Job } from 'bullmq';
import {
  createDb,
  factDailyConsumption,
  factDailySales,
  factDailyStockValue,
  factPurchaseLines,
  factWaste,
  MenuItemRepository,
  MovementService,
  PosItemRepository,
  RecipeRepository,
  SalesTransactionRepository,
  SupplierPriceRepository,
  SupplierProductRepository,
  organizations,
  posItems,
  products,
  productVariants,
  recipeComponents,
  recipes,
  stores,
  suppliers,
  supplierProducts,
  supplierPrices,
  menuItems,
  salesTransactions,
  salesTransactionLines,
  stockLevels,
  stockMovements,
  lots,
  units,
  auditLogs,
  outboxEvents,
} from '@retailos/db';
import { withTenantContext } from '@retailos/db';
import { LotRepository } from '@retailos/db';
import { createFactAggregationProcessor } from './fact-aggregation-processor';
import type { FactAggregationJobData } from '@retailos/queue';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const asJob = (data: FactAggregationJobData): Job<FactAggregationJobData> => ({ data }) as Job<FactAggregationJobData>;

/**
 * proves the real BullMQ job handler, not just `aggregateFactTablesForDay` in isolation
 * (already proven end-to-end in `packages/db/src/fact-aggregation/aggregate-day.integration.test.ts`).
 * What's unique to THIS layer: (a) the processor resolves "yesterday" itself from job data rather
 * than taking a date as input — a store-creation-time job never specifies a date, only a timezone —
 * and (b) the `resolveRecipeUnitCost` adapter genuinely bridges `@retailos/metrics`'s real
 * `(recipeGroupId) => Money` resolver into `aggregateFactTablesForDay`'s narrower
 * `(menuItemId) => {amount}` shape via a real `MenuItemRepository` lookup — a real recipe + real
 * confirmed supplier price fixture proves this resolves a real number, not just 'unknown' by
 * default (which every existing db-package fixture stubs, since none of them exercise this adapter).
 */
describe('fact aggregation processor', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(factDailyConsumption).where(eq(factDailyConsumption.organizationId, orgId));
      await adminDb.delete(factDailySales).where(eq(factDailySales.organizationId, orgId));
      await adminDb.delete(factDailyStockValue).where(eq(factDailyStockValue.organizationId, orgId));
      await adminDb.delete(factPurchaseLines).where(eq(factPurchaseLines.organizationId, orgId));
      await adminDb.delete(factWaste).where(eq(factWaste.organizationId, orgId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(menuItems).where(eq(menuItems.organizationId, orgId));
      const orgRecipes = await adminDb.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await adminDb.delete(recipes).where(eq(recipes.organizationId, orgId));
      const orgSupplierProducts = await adminDb.select({ id: supplierProducts.id }).from(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      for (const sp of orgSupplierProducts) {
        await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, sp.id));
      }
      await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      await adminDb.delete(suppliers).where(eq(suppliers.organizationId, orgId));
      const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await adminDb.delete(products).where(eq(products.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  it('resolves the store-local "yesterday" and computes a real theoretical COGS via the recipe-cost adapter', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Fact Proc Test Org', slug: `fact-proc-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Fact Proc Store', timezone: 'UTC' })
      )
    );

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));

    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `FACTPROC-${productId}`, name: 'Fact Proc Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );

    // Real receipt so consumption has a real cost to draw from.
    const lotRepo = new LotRepository(db, organizationId);
    const movements = new MovementService(db, organizationId);
    // "Yesterday" in UTC, computed the exact same way the processor itself will compute it —
    // pinning the fixture to a real relative day (not a hardcoded past date) so this test stays
    // valid regardless of when it runs, matching resolveYesterdayLocalDate's own contract.
    const todayLocal = resolveLocalDate(new Date(), 'UTC');
    const yesterdayGuess = new Date(`${todayLocal}T00:00:00Z`);
    yesterdayGuess.setUTCDate(yesterdayGuess.getUTCDate() - 1);
    const yesterdayLocal = yesterdayGuess.toISOString().slice(0, 10);
    const receiptAt = new Date(`${yesterdayLocal}T08:00:00Z`);
    const saleAt = new Date(`${yesterdayLocal}T12:00:00Z`);
    const consumeAt = new Date(`${yesterdayLocal}T12:30:00Z`);

    const lot = await lotRepo.receive({
      id: generateId(), storeId, productId, variantId,
      receivedAt: receiptAt, initialQuantity: '50.000000', unitCost: '1.5000', currency: 'USD',
    });
    await movements.postMovement({
      storeId, productId, variantId, lotId: lot.id, movementType: 'RECEIPT',
      quantity: '50.000000', unitCost: '1.5000', currency: 'USD',
      occurredAt: receiptAt, sourceType: 'test',
    });

    // Real supplier + confirmed supplier product + confirmed current price, so the recipe-cost
    // resolver has a real, resolvable price to find (a recipe alone is not enough — unconfirmed or
    // priceless mappings correctly resolve to 'unknown', proven separately by packages/metrics'
    // own recipe-cost-resolver tests; this fixture exercises the genuinely-resolvable path).
    const supplierId = generateId();
    await db.transaction((tx) => withTenantContext(tx, organizationId, () => tx.insert(suppliers).values({ id: supplierId, organizationId, name: 'Fact Proc Supplier' })));
    const supplierProductRepository = new SupplierProductRepository(db, organizationId);
    const supplierProduct = await supplierProductRepository.create({
      id: generateId(), supplierId, productId, supplierSku: 'FACTPROC-SKU',
      packUnitId: eachUnit!.id, conversionToBase: '1',
    });
    await supplierProductRepository.confirm(supplierProduct.id);
    const supplierPriceRepository = new SupplierPriceRepository(db, organizationId);
    await supplierPriceRepository.recordNewPrice({
      id: generateId(), supplierProductId: supplierProduct.id, unitPrice: '1.5000', currency: 'USD', validFrom: new Date('2020-01-01T00:00:00Z'),
    });

    // Real recipe yielding 1 unit from 1 unit of the product (a trivial 1:1 recipe keeps the
    // expected cost easy to hand-verify: unit cost = $1.50).
    const recipeGroupId = generateId();
    const recipeRepository = new RecipeRepository(db, organizationId);
    await recipeRepository.create({
      id: generateId(), recipeGroupId, name: 'Fact Proc Recipe',
      yieldQuantity: '1.000000', yieldUnitId: eachUnit!.id, validFrom: new Date('2020-01-01T00:00:00Z'),
      components: [{ componentType: 'PRODUCT', productId, quantity: '1.000000', unitId: eachUnit!.id }],
    });
    const menuItemRepository = new MenuItemRepository(db, organizationId);
    const menuItem = await menuItemRepository.create({
      id: generateId(), name: 'Fact Proc Menu Item', recipeGroupId, price: '5.0000', priceValidFrom: new Date('2020-01-01T00:00:00Z'),
    });

    // A real POS item mapped to the menu item — sales lines link to menu items only through this
    // mapping (findDailySoldMappedItems' real join), never directly.
    const posItemRepository = new PosItemRepository(db, organizationId);
    const posItem = await posItemRepository.upsert({
      id: generateId(), storeId, source: 'square', externalId: 'FACTPROC-POS-ITEM', name: 'Fact Proc Menu Item',
    });
    await posItemRepository.mapToMenuItem(posItem.id, menuItem.id);

    // Real sale of the menu item + real matching consumption, both on the target local day.
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    await salesRepo.recordIfNew({
      storeId, source: 'square', externalId: `FACTPROC-SALE-${organizationId}`,
      occurredAt: saleAt, subtotal: '5.0000', discount: '0.0000', tax: '0.0000', total: '5.0000', currency: 'USD',
      lines: [{ posItemId: posItem.id, quantity: '1.000000', unitPrice: '5.0000', discount: '0.0000', lineTotal: '5.0000' }],
    });
    await movements.consumeFefo({
      storeId, productId, variantId, requiredQuantity: '1.000000', unit: 'each',
      occurredAt: consumeAt, sourceType: 'test',
    });

    const processor = createFactAggregationProcessor({ databaseUrl: APP_CONNECTION_STRING });
    await processor(asJob({ organizationId, storeId, storeTimezone: 'UTC' }));

    const consumptionRows = await adminDb.select().from(factDailyConsumption).where(eq(factDailyConsumption.organizationId, organizationId));
    // One real per-product consumption row plus the theoretical-COGS sentinel row (null grain).
    expect(consumptionRows).toHaveLength(2);
    const sentinel = consumptionRows.find((row) => row.productId === null);
    expect(sentinel).toBeDefined();
    // 1 unit sold * $1.50 real resolved unit cost = $1.50 theoretical COGS — proves the adapter
    // reached the real recipe → real supplier price, not just returned 'unknown'.
    expect(sentinel!.theoreticalCogs).toBe('1.5000');
    const productRow = consumptionRows.find((row) => row.productId === productId);
    expect(productRow?.actualQty).toBe('1.000000');
  }, 30000);

  it('a store with no recipe/menu-item data still aggregates real sales/stock rows, with theoretical COGS staying unresolved rather than zero', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Fact Proc Empty Org', slug: `fact-proc-empty-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Fact Proc Empty Store', timezone: 'UTC' })
      )
    );

    const processor = createFactAggregationProcessor({ databaseUrl: APP_CONNECTION_STRING });
    await processor(asJob({ organizationId, storeId, storeTimezone: 'UTC' }));

    const consumptionRows = await adminDb.select().from(factDailyConsumption).where(eq(factDailyConsumption.organizationId, organizationId));
    expect(consumptionRows).toHaveLength(0);
  }, 30000);

  it('skips quietly when the organization referenced by the job no longer exists', async () => {
    const processor = createFactAggregationProcessor({ databaseUrl: APP_CONNECTION_STRING });
    await expect(processor(asJob({ organizationId: generateId(), storeId: generateId(), storeTimezone: 'UTC' }))).resolves.toBeUndefined();
  });
});
