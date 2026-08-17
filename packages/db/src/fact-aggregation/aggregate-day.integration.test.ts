import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import { createDb } from '../client';
import {
  auditLogs,
  documents,
  factDailySales,
  factDailyConsumption,
  factDailyStockValue,
  factPurchaseLines,
  factWaste,
  lots,
  menuItems,
  organizations,
  outboxEvents,
  posItems,
  products,
  productVariants,
  purchaseOrders,
  purchaseOrderLines,
  salesTransactionLines,
  salesTransactions,
  stockLevels,
  stockMovements,
  stores,
  suppliers,
  supplierProducts,
  supplierPrices,
  units,
} from '../schema/index';
import { withTenantContext } from '../tenant-context';
import { aggregateFactTablesForDay } from './aggregate-day';
import { LotRepository } from '../repositories/lot-repository';
import { MovementService } from '../repositories/movement-service';
import { PurchaseOrderRepository } from '../repositories/purchase-order-repository';
import { SalesTransactionRepository } from '../repositories/sales-transaction-repository';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real end-to-end proof that `aggregateFactTablesForDay` genuinely populates all 5 fact tables from
 * real source rows, and that re-running it for the SAME day is genuinely idempotent (the "fully
 * rebuildable from source" requirement, plan.md) — not just asserted by convention, proven by
 * actually calling it twice and confirming the second run produces byte-identical row counts, not
 * duplicates.
 */
describe('aggregateFactTablesForDay — real end-to-end', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(factDailySales).where(eq(factDailySales.organizationId, orgId));
      await adminDb.delete(factDailyConsumption).where(eq(factDailyConsumption.organizationId, orgId));
      await adminDb.delete(factDailyStockValue).where(eq(factDailyStockValue.organizationId, orgId));
      await adminDb.delete(factPurchaseLines).where(eq(factPurchaseLines.organizationId, orgId));
      await adminDb.delete(factWaste).where(eq(factWaste.organizationId, orgId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, orgId));
      await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));
      await adminDb.delete(documents).where(eq(documents.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(menuItems).where(eq(menuItems.organizationId, orgId));
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

  afterAll(async () => {
    await adminClient.end();
  });

  it('populates real fact rows from real sales/consumption/waste/purchase/stock data, and re-running the SAME day is genuinely idempotent', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Fact Agg Test Org', slug: `fact-agg-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Fact Agg Store', timezone: 'America/New_York' })
      )
    );

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `FACT-${productId}`, name: 'Fact Agg Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );

    // Fixed to a real, known past local date so the test is deterministic regardless of when it runs.
    const localDate = '2026-06-15';

    // Real receipt (feeds fact_daily_stock_value).
    const lotRepo = new LotRepository(db, organizationId);
    const movements = new MovementService(db, organizationId);
    const lot = await lotRepo.receive({
      id: generateId(), storeId, productId, variantId,
      receivedAt: new Date('2026-06-10T12:00:00Z'), initialQuantity: '100.000000', unitCost: '2.0000', currency: 'USD',
    });
    await movements.postMovement({
      storeId, productId, variantId, lotId: lot.id, movementType: 'RECEIPT',
      quantity: '100.000000', unitCost: '2.0000', currency: 'USD',
      occurredAt: new Date('2026-06-10T12:00:00Z'), sourceType: 'test',
    });

    // Real sale on the target local day (14:00 EDT -> 18:00Z, well inside the window).
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    await salesRepo.recordIfNew({
      storeId, source: 'square', externalId: `FACT-SALE-${organizationId}`,
      occurredAt: new Date('2026-06-15T18:00:00Z'), subtotal: '50.0000', discount: '5.0000', tax: '0.0000', total: '45.0000', currency: 'USD',
      lines: [{ quantity: '5.000000', unitPrice: '10.0000', discount: '0.0000', lineTotal: '50.0000' }],
    });

    // Real consumption on the target day.
    await movements.consumeFefo({
      storeId, productId, variantId, requiredQuantity: '5.000000', unit: 'each',
      occurredAt: new Date('2026-06-15T18:30:00Z'), sourceType: 'test',
    });

    // Real waste on the target day.
    await movements.logWaste({
      storeId, productId, variantId, quantity: '2.000000', unit: 'each', reasonCode: 'SPILLAGE',
      occurredAt: new Date('2026-06-15T19:00:00Z'), sourceType: 'test',
    });

    // Real PO created on the target day.
    const supplierId = generateId();
    await db.transaction((tx) => withTenantContext(tx, organizationId, () => tx.insert(suppliers).values({ id: supplierId, organizationId, name: 'Fact Agg Supplier' })));
    const supplierProductId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: 'FACT-SKU', isConfirmed: true })
      )
    );
    const poRepo = new PurchaseOrderRepository(db, organizationId);
    const { id: poId } = await poRepo.create({ storeId, supplierId, poNumber: `FACT-PO-${generateId()}`, currency: 'USD' });
    // Backdate createdAt to the target local day (create() always stamps real "now") — a real,
    // parameterized admin-connection UPDATE, matching this project's own established pattern for
    // backdating a "now"-stamped column in a wiring test (see 009-09's own lead-time test fix).
    await adminDb.update(purchaseOrders).set({ createdAt: new Date('2026-06-15T18:00:00Z') }).where(eq(purchaseOrders.id, poId));
    await poRepo.addLine({
      purchaseOrderId: poId, supplierProductId, productId, variantId,
      quantityOrderUnits: '20.000000', conversionToBase: '1', unitPrice: '2.5000', lineNumber: 1,
    });

    const resolveRecipeUnitCost = async () => 'unknown' as const; // no recipe seeded in this fixture — theoretical COGS correctly stays unresolved

    // Run 1
    await aggregateFactTablesForDay(db, organizationId, storeId, 'America/New_York', localDate, resolveRecipeUnitCost);

    const salesRows1 = await adminDb.select().from(factDailySales).where(eq(factDailySales.organizationId, organizationId));
    const consumptionRows1 = await adminDb.select().from(factDailyConsumption).where(eq(factDailyConsumption.organizationId, organizationId));
    const stockValueRows1 = await adminDb.select().from(factDailyStockValue).where(eq(factDailyStockValue.organizationId, organizationId));
    const purchaseLineRows1 = await adminDb.select().from(factPurchaseLines).where(eq(factPurchaseLines.organizationId, organizationId));
    const wasteRows1 = await adminDb.select().from(factWaste).where(eq(factWaste.organizationId, organizationId));

    expect(salesRows1).toHaveLength(1);
    expect(salesRows1[0]!.netRevenue).toBe('45.0000'); // 50 - 5 discount - 0 refund
    expect(consumptionRows1).toHaveLength(1); // real consumption, no sentinel (theoretical is unknown)
    expect(consumptionRows1[0]!.actualQty).toBe('5.000000');
    expect(consumptionRows1[0]!.actualCogs).toBe('10.0000'); // 5 * 2.00
    expect(stockValueRows1).toHaveLength(1);
    // 100 received - 5 consumed - 2 wasted = 93 remaining, at $2.00 -> $186.00
    expect(stockValueRows1[0]!.qtyOnHand).toBe('93.000000');
    expect(purchaseLineRows1).toHaveLength(1);
    expect(purchaseLineRows1[0]!.total).toBe('50.0000'); // 20 * 2.50
    expect(wasteRows1).toHaveLength(1);
    expect(wasteRows1[0]!.qty).toBe('2.000000');

    // Run 2 — the SAME day, re-aggregated. Real idempotency proof: identical row counts, not duplicates.
    await aggregateFactTablesForDay(db, organizationId, storeId, 'America/New_York', localDate, resolveRecipeUnitCost);

    const salesRows2 = await adminDb.select().from(factDailySales).where(eq(factDailySales.organizationId, organizationId));
    const consumptionRows2 = await adminDb.select().from(factDailyConsumption).where(eq(factDailyConsumption.organizationId, organizationId));
    const stockValueRows2 = await adminDb.select().from(factDailyStockValue).where(eq(factDailyStockValue.organizationId, organizationId));
    const purchaseLineRows2 = await adminDb.select().from(factPurchaseLines).where(eq(factPurchaseLines.organizationId, organizationId));
    const wasteRows2 = await adminDb.select().from(factWaste).where(eq(factWaste.organizationId, organizationId));

    expect(salesRows2).toHaveLength(1);
    expect(consumptionRows2).toHaveLength(1);
    expect(stockValueRows2).toHaveLength(1);
    expect(purchaseLineRows2).toHaveLength(1);
    expect(wasteRows2).toHaveLength(1);
    // Real, different row ids each rebuild (delete-then-insert, not an update) — but the SAME real values.
    expect(salesRows2[0]!.netRevenue).toBe(salesRows1[0]!.netRevenue);
    expect(stockValueRows2[0]!.qtyOnHand).toBe(stockValueRows1[0]!.qtyOnHand);
  });

  it('a genuinely empty store/day produces zero fact rows across every table, not fabricated zero-value rows', async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Fact Agg Empty Org', slug: `fact-agg-empty-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Empty Store', timezone: 'UTC' })
      )
    );

    await aggregateFactTablesForDay(db, organizationId, storeId, 'UTC', '2026-06-15', async () => 'unknown' as const);

    const salesRows = await adminDb.select().from(factDailySales).where(eq(factDailySales.organizationId, organizationId));
    const consumptionRows = await adminDb.select().from(factDailyConsumption).where(eq(factDailyConsumption.organizationId, organizationId));
    const stockValueRows = await adminDb.select().from(factDailyStockValue).where(eq(factDailyStockValue.organizationId, organizationId));
    const purchaseLineRows = await adminDb.select().from(factPurchaseLines).where(eq(factPurchaseLines.organizationId, organizationId));
    const wasteRows = await adminDb.select().from(factWaste).where(eq(factWaste.organizationId, organizationId));

    expect(salesRows).toHaveLength(0);
    expect(consumptionRows).toHaveLength(0);
    expect(stockValueRows).toHaveLength(0);
    expect(purchaseLineRows).toHaveLength(0);
    expect(wasteRows).toHaveLength(0);
  });
});
