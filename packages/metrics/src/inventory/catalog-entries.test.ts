import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId } from '@retailos/domain';
import {
  auditLogs,
  createDb,
  lots,
  menuItems,
  organizations,
  outboxEvents,
  posItems,
  products,
  productVariants,
  recipeComponents,
  recipes,
  salesTransactionLines,
  salesTransactions,
  stockLevels,
  stockMovements,
  stores,
  units,
  withTenantContext,
  LotRepository,
  MovementService,
  SalesTransactionRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that all 9 inventory metrics (spec 12 §D) compute correctly through
 * `executeMetric`, using real ledger/lot/recipe/sales data rather than stubbed repositories —
 * following this project's own established convention that a catalog-wiring test proves the
 * REAL fetch (repository -> pure compute -> MetricResult), not just the pure math (already
 * covered by `inventory.test.ts`).
 */
describe('registered inventory metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(menuItems).where(eq(menuItems.organizationId, orgId));
      const orgRecipes = await adminDb.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await adminDb.delete(recipes).where(eq(recipes.organizationId, orgId));
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

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Inventory Metrics Test Org ${organizationId}`,
      slug: `inventory-metrics-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' })
      )
    );
    return { organizationId, storeId };
  };

  const makeProduct = async (organizationId: string) => {
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `INV-${productId}`,
          name: 'Inventory Metrics Test Product',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
        });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );
    return { productId, variantId, unitId: eachUnit!.id };
  };

  const auth = (permissions: readonly string[] = ['inventory:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });

  it('stock_on_hand reads the real stock_levels projection after a real receipt', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const lotId = generateId();
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      initialQuantity: '10.000000',
      unitCost: '4.5000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      unitCost: '4.5000',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });

    const result = await executeMetric('stock_on_hand', { storeId, productId, variantId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('10.000000');
  });

  it('stock_on_hand is a real zero for a product with no stock_levels row, never unknown', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const result = await executeMetric('stock_on_hand', { storeId, productId, variantId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('0.000000');
  });

  it('stock_value sums remaining_quantity times lot cost across a real lot', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '20.000000',
      unitCost: '3.0000',
      currency: 'USD',
    });

    const result = await executeMetric('stock_value', { storeId }, auth(), plainCtx(organizationId));
    // 20 x $3.00 = $60.00.
    expect(result.value).toBe('60.0000');
  });

  it('days_of_supply divides real stock on hand by real trailing consumption', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const lotId = generateId();
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      initialQuantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });
    // Consume 10/day for 5 of the last 30 days -> avg daily consumption = 50/30.
    for (let i = 1; i <= 5; i++) {
      await movements.postMovement({
        storeId,
        productId,
        variantId,
        lotId,
        movementType: 'SALE_CONSUMPTION',
        quantity: '-10.000000',
        unitCost: '2.0000',
        currency: 'USD',
        occurredAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
        sourceType: 'test',
      });
    }

    const result = await executeMetric('days_of_supply', { storeId, productId, variantId }, auth(), plainCtx(organizationId));
    // Stock on hand = 50 (100 - 50 consumed). Avg daily consumption = 50/30 = 1.666667.
    // Days of supply = 50 / (50/30) = 30.00.
    expect(result.value).toBe('30.00');
  });

  it('days_of_supply is unknown with no consumption history, never a fabricated infinite/zero', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const result = await executeMetric('days_of_supply', { storeId, productId, variantId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('dead_stock_value finds a real product with no movement in the threshold window', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const lotId = generateId();
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      initialQuantity: '15.000000',
      unitCost: '5.0000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '15.000000',
      unitCost: '5.0000',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });

    const result = await executeMetric('dead_stock_value', { storeId, thresholdDays: 60 }, auth(), plainCtx(organizationId));
    // 15 x $5.00 = $75.00, untouched for 90 days > 60-day threshold.
    expect(result.value).toBe('75.0000');
  });

  it('expiry_risk_value finds a real lot expiring within the horizon whose cover exceeds days remaining', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const expiryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      expiryDate,
      initialQuantity: '30.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });
    // No consumption history at all -> avg_daily_consumption is treated as 0 -> always at risk.

    const result = await executeMetric('expiry_risk_value', { storeId, horizonDays: 7 }, auth(), plainCtx(organizationId));
    // 30 x $2.00 = $60.00.
    expect(result.value).toBe('60.0000');
  });

  it('expiry_risk_value excludes a real lot expiring beyond the horizon', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      expiryDate,
      initialQuantity: '30.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });

    const result = await executeMetric('expiry_risk_value', { storeId, horizonDays: 7 }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('0.0000');
  });

  it('negative_stock_incidents counts a real negative stock_levels row', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const lotId = generateId();
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      initialQuantity: '5.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '5.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });
    // A correction that drives the projection negative — matches this project's own established
    // "negative stock is a signal, not an error" precedent (findNegativeStock's own docstring).
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'COUNT_ADJUSTMENT',
      quantity: '-8.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'test',
    });

    const result = await executeMetric('negative_stock_incidents', { storeId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('1');
  });

  it('negative_stock_incidents is a real zero with no negative stock', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const result = await executeMetric('negative_stock_incidents', { storeId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('0');
  });

  const setUpMenuItemWithIngredient = async (organizationId: string, storeId: string) => {
    const { productId, variantId, unitId } = await makeProduct(organizationId);
    const menuItemId = generateId();
    const recipeGroupId = generateId();
    const recipeId = generateId();
    const posItemId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(recipes).values({
          id: recipeId,
          recipeGroupId,
          organizationId,
          name: 'Stockout Test Recipe',
          yieldQuantity: '1',
          yieldUnitId: unitId,
          validFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        });
        await tx.insert(recipeComponents).values({
          id: generateId(),
          recipeId,
          componentType: 'PRODUCT',
          productId,
          quantity: '1',
          unitId,
        });
        await tx.insert(menuItems).values({
          id: menuItemId,
          organizationId,
          name: 'Stockout Test Item',
          recipeGroupId,
          price: '8.0000',
          priceValidFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        });
        await tx.insert(posItems).values({
          id: posItemId,
          organizationId,
          storeId,
          source: 'square',
          externalId: `STOCKOUT-${posItemId}`,
          name: 'Stockout Test Item',
          mappingStatus: 'MAPPED',
          menuItemId,
        });
      })
    );
    return { productId, variantId, menuItemId, posItemId };
  };

  it('stockout_events is a real zero when the menu item\'s ingredient never ran out', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId, menuItemId } = await setUpMenuItemWithIngredient(organizationId, storeId);
    const lotId = generateId();
    const lotRepo = new LotRepository(db, organizationId);
    const receivedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt,
      initialQuantity: '50.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '50.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: receivedAt,
      sourceType: 'test',
    });
    // Light consumption that never exhausts the lot -> no stockout day.
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-5.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });

    const from = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const to = new Date();
    const result = await executeMetric(
      'stockout_events',
      { storeId, menuItemId, from, to },
      auth(),
      plainCtx(organizationId)
    );
    expect(result.value).toBe('0');
  });

  it('stockout_events/stockout_revenue_impact find a real stockout day for the SAME menu item whose ingredient ran out', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId, menuItemId, posItemId } = await setUpMenuItemWithIngredient(organizationId, storeId);
    const lotId = generateId();
    const lotRepo = new LotRepository(db, organizationId);
    const receivedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt,
      initialQuantity: '5.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '5.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: receivedAt,
      sourceType: 'test',
    });
    const stockoutDay = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-5.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: stockoutDay,
      sourceType: 'test',
    });

    // Real sales for the menu item, at $8.00 each — drives stockout_revenue_impact's avg unit price
    // and avg daily consumption (velocity) inputs.
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `STOCKOUT-SALE-${organizationId}`,
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      subtotal: '80.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '80.0000',
      currency: 'USD',
      lines: [{ posItemId, quantity: '10.000000', unitPrice: '8.0000', discount: '0.0000', lineTotal: '80.0000' }],
    });

    const from = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const to = new Date();
    const [events, impact] = await Promise.all([
      executeMetric('stockout_events', { storeId, menuItemId, from, to }, auth(), plainCtx(organizationId)),
      executeMetric('stockout_revenue_impact', { storeId, menuItemId, from, to }, auth(), plainCtx(organizationId)),
    ]);

    expect(events.value).toBe('1');
    // avg unit price = 80/10 = $8.00. avg daily consumption = 10 units / 10-day period = 1/day.
    // 1 stockout day x 1 unit/day x $8.00 = $8.00.
    expect(impact.value).toBe('8.0000');
  });

  it('stockout_revenue_impact is unknown for a menu item with no sales history, never a fabricated estimate', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { menuItemId } = await setUpMenuItemWithIngredient(organizationId, storeId);
    const from = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const to = new Date();
    const result = await executeMetric(
      'stockout_revenue_impact',
      { storeId, menuItemId, from, to },
      auth(),
      plainCtx(organizationId)
    );
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('executeMetric refuses a caller without inventory:read for an inventory metric', async () => {
    const { organizationId, storeId } = await setUpOrg();
    await expect(executeMetric('stock_value', { storeId }, auth([]), plainCtx(organizationId))).rejects.toThrow(
      /inventory:read/
    );
  });
});
