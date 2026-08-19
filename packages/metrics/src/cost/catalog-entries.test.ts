import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId, money } from '@retailos/domain';
import {
  auditLogs,
  createDb,
  lots,
  organizations,
  outboxEvents,
  products,
  productVariants,
  recipeComponents,
  recipes,
  menuItems,
  stockLevels,
  stockMovements,
  stores,
  supplierPrices,
  supplierProducts,
  suppliers,
  units,
  withTenantContext,
  LotRepository,
  MovementService,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import type { CostMetricContext } from './catalog-entries.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that the 4 newly-registered cost metrics compute correctly
 * through `executeMetric`. The other 4 of the section's 8 metrics (`cogs_actual`,
 * `cogs_theoretical`, `food_cost_percentage`, `cost_variance`) are already covered by
 * `margin/catalog-entries.test.ts`.
 */
describe('registered cost metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      // stock_movements references lots; lots and stock_levels both reference product_variants —
      // all three must go before product_variants is deleted below.
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(menuItems).where(eq(menuItems.organizationId, orgId));
      const orgRecipes = await adminDb.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await adminDb.delete(recipes).where(eq(recipes.organizationId, orgId));
      const orgSupplierProducts = await adminDb
        .select({ id: supplierProducts.id })
        .from(supplierProducts)
        .where(eq(supplierProducts.organizationId, orgId));
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

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Cost Metrics Test Org ${organizationId}`,
      slug: `cost-metrics-test-${organizationId}`,
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

  const auth = (permissions: readonly string[] = ['financial:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });

  it('unit_cost_weighted_avg reads the real stock_levels.avgUnitCost after a real receipt', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `COST-A-${productId}`,
          name: 'Weighted Avg Test',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
        });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );

    // stock_levels.avgUnitCost is maintained by MovementService as REAL movements post, not by
    // LotRepository.receive alone (which only writes the lots table itself) — a real RECEIPT
    // movement is what this metric's whole point depends on.
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

    const result = await executeMetric(
      'unit_cost_weighted_avg',
      { storeId, productId, variantId },
      auth(),
      plainCtx(organizationId)
    );

    expect(result.value).toBe('4.5000');
  });

  it('unit_cost_weighted_avg is unknown for a product/variant with no recorded stock movement, never a fabricated zero', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `COST-U-${productId}`,
          name: 'No Movement Test',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
        });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );

    const result = await executeMetric(
      'unit_cost_weighted_avg',
      { storeId, productId, variantId },
      auth(),
      plainCtx(organizationId)
    );

    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('unit_cost_latest reads the real currently-effective supplier price', async () => {
    const { organizationId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const supplierId = generateId();
    const supplierProductId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `COST-L-${productId}`,
          name: 'Latest Price Test',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
        });
        await tx.insert(suppliers).values({ id: supplierId, organizationId, name: 'Test Supplier' });
        await tx.insert(supplierProducts).values({
          id: supplierProductId,
          organizationId,
          supplierId,
          productId,
          supplierSku: 'LT-1',
          packSize: '1',
          packUnitId: eachUnit!.id,
          conversionToBase: '1',
          isConfirmed: true,
        });
        await tx.insert(supplierPrices).values({
          id: generateId(),
          supplierProductId,
          unitPrice: '7.2500',
          currency: 'USD',
          validFrom: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        });
      })
    );

    const result = await executeMetric(
      'unit_cost_latest',
      { supplierProductId },
      auth(),
      plainCtx(organizationId)
    );

    expect(result.value).toBe('7.2500');
  });

  it('unit_cost_latest is unknown when no currently-effective price exists', async () => {
    const { organizationId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const supplierId = generateId();
    const supplierProductId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `COST-NL-${productId}`,
          name: 'No Price Test',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
        });
        await tx.insert(suppliers).values({ id: supplierId, organizationId, name: 'No Price Supplier' });
        await tx.insert(supplierProducts).values({
          id: supplierProductId,
          organizationId,
          supplierId,
          productId,
          supplierSku: 'NL-1',
          packSize: '1',
          packUnitId: eachUnit!.id,
          conversionToBase: '1',
          isConfirmed: true,
        });
      })
    );

    const result = await executeMetric(
      'unit_cost_latest',
      { supplierProductId },
      auth(),
      plainCtx(organizationId)
    );

    expect(result.value).toBe('unknown');
  });

  it('recipe_cost and menu_item_cost agree with a hand-derived figure via the real injected resolver', async () => {
    const { organizationId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const unitId = eachUnit!.id;

    // One ingredient at a known, confirmed supplier price: $10 per pack of 10 = $1.00 per unit.
    const productId = generateId();
    const supplierId = generateId();
    const supplierProductId = generateId();
    const recipeGroupId = generateId();
    const recipeId = generateId();
    const menuItemId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `COST-R-${productId}`,
          name: 'Recipe Cost Test Ingredient',
          baseUnitId: unitId,
          type: 'INGREDIENT',
        });
        await tx.insert(suppliers).values({ id: supplierId, organizationId, name: 'Recipe Cost Test Supplier' });
        await tx.insert(supplierProducts).values({
          id: supplierProductId,
          organizationId,
          supplierId,
          productId,
          supplierSku: 'RC-1',
          packSize: '10',
          packUnitId: unitId,
          conversionToBase: '10',
          isConfirmed: true,
        });
        await tx.insert(supplierPrices).values({
          id: generateId(),
          supplierProductId,
          unitPrice: '10.0000',
          currency: 'USD',
          validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });

        // Recipe: 20 units of the ingredient, yielding 10 portions.
        // Batch cost = 20 x $1.00 = $20.00 -> per-portion cost = $2.00.
        await tx.insert(recipes).values({
          id: recipeId,
          recipeGroupId,
          organizationId,
          name: 'Recipe Cost Test Recipe',
          yieldQuantity: '10',
          yieldUnitId: unitId,
          validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });
        await tx.insert(recipeComponents).values({
          id: generateId(),
          recipeId,
          componentType: 'PRODUCT',
          productId,
          quantity: '20',
          unitId,
        });

        await tx.insert(menuItems).values({
          id: menuItemId,
          organizationId,
          name: 'Recipe Cost Test Menu Item',
          recipeGroupId,
          price: '5.0000',
          priceValidFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });
      })
    );

    // A minimal, real resolveRecipeCostBreakdown/resolveRecipeUnitCost stand-in that reproduces
    // the exact arithmetic apps/api's real resolver performs for this single-ingredient, no-conversion
    // fixture (20 units @ $1.00/unit = $20.00 batch; ÷ yield of 10 = $2.00/portion) — proving the
    // catalog wiring (params -> injected resolver -> MetricResult), not re-testing recipe
    // explosion/unit conversion themselves, which is 007/apps/api's own scope.
    const ctx: CostMetricContext = {
      db,
      organizationId,
      storeIds: 'ALL',
      resolveRecipeCostBreakdown: async () => ({ total: money('20.0000', 'USD') }),
      resolveRecipeUnitCost: async () => money('2.0000', 'USD'),
    };

    const [recipeCost, menuItemCost] = await Promise.all([
      executeMetric('recipe_cost', { recipeGroupId }, auth(), ctx),
      executeMetric('menu_item_cost', { menuItemId }, auth(), ctx),
    ]);

    expect(recipeCost.value).toBe('20.0000');
    expect(menuItemCost.value).toBe('2.0000');
  });

  it('menu_item_cost is unknown for a nonexistent menu item, never a fabricated zero', async () => {
    const { organizationId } = await setUpOrg();
    const ctx: CostMetricContext = {
      db,
      organizationId,
      storeIds: 'ALL',
      resolveRecipeCostBreakdown: async () => ({ total: 'unknown' }),
      resolveRecipeUnitCost: async () => 'unknown',
    };

    const result = await executeMetric('menu_item_cost', { menuItemId: generateId() }, auth(), ctx);
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toMatch(/not found/);
  });

  it('executeMetric refuses a caller without financial:read for a cost metric', async () => {
    const { organizationId, storeId } = await setUpOrg();
    await expect(
      executeMetric(
        'unit_cost_weighted_avg',
        { storeId, productId: generateId(), variantId: generateId() },
        auth([]),
        plainCtx(organizationId)
      )
    ).rejects.toThrow(/financial:read/);
  });
});
