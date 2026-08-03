import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import {
  auditLogs,
  lots,
  menuItems,
  organizations,
  outboxEvents,
  productVariants,
  products,
  recipeComponents,
  recipes,
  stockLevels,
  stockMovements,
  stores,
  units,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SaleConsumptionService } from './sale-consumption-service';
import { MenuItemRepository } from './menu-item-repository';
import { RecipeRepository } from './recipe-repository';
import { ProductRepository } from './product-repository';
import { LotRepository } from './lot-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SaleConsumptionService', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let gramUnitId: string;
  let eachUnitId: string;
  let flourId: string;
  let flourVariantId: string;
  let cheeseId: string;
  let cheeseVariantId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Sale Consumption Test Org',
      slug: `sale-consumption-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({
      id: storeId,
      organizationId,
      name: 'Main Store',
      timezone: 'America/New_York',
    });

    const existingGram = await adminDb.select().from(units).where(eq(units.code, 'g'));
    gramUnitId = existingGram[0]?.id ?? generateId();
    if (!existingGram[0]) {
      await adminDb.insert(units).values({ id: gramUnitId, code: 'g', dimension: 'MASS', isBase: true });
    }
    const existingEach = await adminDb.select().from(units).where(eq(units.code, 'each'));
    eachUnitId = existingEach[0]?.id ?? generateId();
    if (!existingEach[0]) {
      await adminDb.insert(units).values({ id: eachUnitId, code: 'each', dimension: 'COUNT', isBase: true });
    }

    const productRepo = new ProductRepository(createScopedDb(client), organizationId);
    const flour = await productRepo.create({
      id: generateId(),
      sku: `FLOUR-${generateId()}`,
      name: 'Flour',
      baseUnitId: gramUnitId,
      type: 'INGREDIENT',
    });
    flourId = flour.id;
    flourVariantId = (await productRepo.findVariants(flourId))[0]!.id;

    const cheese = await productRepo.create({
      id: generateId(),
      sku: `CHEESE-${generateId()}`,
      name: 'Cheese',
      baseUnitId: gramUnitId,
      type: 'INGREDIENT',
    });
    cheeseId = cheese.id;
    cheeseVariantId = (await productRepo.findVariants(cheeseId))[0]!.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    await adminDb.delete(lots).where(eq(lots.organizationId, organizationId));
    await adminDb.delete(menuItems).where(eq(menuItems.organizationId, organizationId));
    const recipeRows = await adminDb.select().from(recipes).where(eq(recipes.organizationId, organizationId));
    for (const r of recipeRows) {
      await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
    }
    await adminDb.delete(recipes).where(eq(recipes.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(productVariants).where(eq(productVariants.productId, flourId));
    await adminDb.delete(productVariants).where(eq(productVariants.productId, cheeseId));
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('returns menu_item_not_found without throwing when the menu item does not exist', async () => {
    const service = new SaleConsumptionService(createScopedDb(client), organizationId);
    const result = await service.recordSaleConsumption({
      storeId,
      menuItemId: generateId(),
      quantitySold: '1',
      occurredAt: new Date(),
      currency: 'USD',
      sourceType: 'pos-sync',
    });

    expect(result.status).toBe('menu_item_not_found');
  });

  it('returns recipe_not_found (never a guessed cost) when the menu item has no recipe version valid at the sale time', async () => {
    const menuItemRepo = new MenuItemRepository(createScopedDb(client), organizationId);
    const menuItem = await menuItemRepo.create({
      id: generateId(),
      name: 'Orphan Sandwich',
      recipeGroupId: generateId(), // deliberately never created
      price: '5.00',
      priceValidFrom: new Date('2020-01-01T00:00:00Z'),
    });

    const service = new SaleConsumptionService(createScopedDb(client), organizationId);
    const result = await service.recordSaleConsumption({
      storeId,
      menuItemId: menuItem.id,
      quantitySold: '1',
      occurredAt: new Date(),
      currency: 'USD',
      sourceType: 'pos-sync',
    });

    expect(result.status).toBe('recipe_not_found');
  });

  it('explodes a recipe, FEFO-consumes each ingredient, and records real actual COGS from the allocated lot costs', async () => {
    const recipeRepo = new RecipeRepository(createScopedDb(client), organizationId);
    const recipeGroupId = generateId();
    await recipeRepo.create({
      id: generateId(),
      recipeGroupId,
      name: 'Grilled Cheese',
      yieldQuantity: '1',
      yieldUnitId: eachUnitId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [
        { componentType: 'PRODUCT', productId: flourId, quantity: '50', unitId: gramUnitId },
        { componentType: 'PRODUCT', productId: cheeseId, quantity: '30', unitId: gramUnitId },
      ],
    });

    const menuItemRepo = new MenuItemRepository(createScopedDb(client), organizationId);
    const menuItem = await menuItemRepo.create({
      id: generateId(),
      name: 'Grilled Cheese Sandwich',
      recipeGroupId,
      price: '6.50',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId: flourId,
      variantId: flourVariantId,
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      initialQuantity: '1000.000000',
      unitCost: '0.0020',
      currency: 'USD',
    });
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId: cheeseId,
      variantId: cheeseVariantId,
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      initialQuantity: '1000.000000',
      unitCost: '0.0100',
      currency: 'USD',
    });

    const service = new SaleConsumptionService(createScopedDb(client), organizationId);
    const result = await service.recordSaleConsumption({
      storeId,
      menuItemId: menuItem.id,
      quantitySold: '2', // 2 sandwiches -> 100g flour, 60g cheese
      occurredAt: new Date('2026-01-02T00:00:00Z'),
      currency: 'USD',
      sourceType: 'pos-sync',
    });

    expect(result.status).toBe('consumed');
    if (result.status !== 'consumed') throw new Error('unreachable');
    expect(result.ingredients).toHaveLength(2);
    expect(result.ingredients.every((i) => i.status === 'consumed')).toBe(true);
    // 100g flour @ 0.0020/g = 0.20; 60g cheese @ 0.0100/g = 0.60; total = 0.80
    expect(result.actualCogs !== 'unknown' && result.actualCogs.amount.toString()).toBe('0.8');

    const adminDb = drizzle(adminClient, { schema });
    const flourMovements = await adminDb
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.variantId, flourVariantId));
    expect(flourMovements).toHaveLength(1);
    expect(flourMovements[0]?.quantity).toBe('-100.000000');
    expect(flourMovements[0]?.movementType).toBe('SALE_CONSUMPTION');
  });

  it('one ingredient with insufficient stock is flagged, but other ingredients in the same sale still consume normally (I7 — never a plausible-looking wrong total)', async () => {
    const recipeRepo = new RecipeRepository(createScopedDb(client), organizationId);
    const recipeGroupId = generateId();
    await recipeRepo.create({
      id: generateId(),
      recipeGroupId,
      name: 'Cheese Toast',
      yieldQuantity: '1',
      yieldUnitId: eachUnitId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [
        { componentType: 'PRODUCT', productId: flourId, quantity: '1000', unitId: gramUnitId }, // way more than on hand
        { componentType: 'PRODUCT', productId: cheeseId, quantity: '20', unitId: gramUnitId },
      ],
    });

    const menuItemRepo = new MenuItemRepository(createScopedDb(client), organizationId);
    const menuItem = await menuItemRepo.create({
      id: generateId(),
      name: 'Cheese Toast',
      recipeGroupId,
      price: '4.00',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId: flourId,
      variantId: flourVariantId,
      receivedAt: new Date(),
      initialQuantity: '5.000000', // far short of 1000g needed
      unitCost: '0.0020',
      currency: 'USD',
    });
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId: cheeseId,
      variantId: cheeseVariantId,
      receivedAt: new Date(),
      initialQuantity: '100.000000',
      unitCost: '0.0100',
      currency: 'USD',
    });

    const service = new SaleConsumptionService(createScopedDb(client), organizationId);
    const result = await service.recordSaleConsumption({
      storeId,
      menuItemId: menuItem.id,
      quantitySold: '1',
      occurredAt: new Date(),
      currency: 'USD',
      sourceType: 'pos-sync',
    });

    expect(result.status).toBe('consumed');
    if (result.status !== 'consumed') throw new Error('unreachable');
    const flourResult = result.ingredients.find((i) => i.productId === flourId);
    const cheeseResult = result.ingredients.find((i) => i.productId === cheeseId);
    expect(flourResult?.status).toBe('insufficient_stock');
    expect(flourResult?.actualCost).toBe('unknown');
    expect(cheeseResult?.status).toBe('consumed');
    // The overall COGS is 'unknown' because one line is - never a partial sum (I7).
    expect(result.actualCogs).toBe('unknown');

    // The cheese line still posted a real movement despite flour's shortfall.
    const adminDb = drizzle(adminClient, { schema });
    const cheeseMovements = await adminDb
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.variantId, cheeseVariantId));
    expect(cheeseMovements).toHaveLength(1);
    expect(cheeseMovements[0]?.quantity).toBe('-20.000000');

    // Flour's lot was never touched by the failed allocation.
    const flourLots = await lotRepo.findFefoCandidates(storeId, flourId);
    expect(flourLots[0]?.remainingQuantity).toBe('5.000000');
  });

  it('cross-tenant: a menu item id from another tenant is reported as not found, never resolved', async () => {
    const fixture: TwoTenantFixture = await setUpTwoTenants();
    try {
      const menuItemRepoB = new MenuItemRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const menuItemB = await menuItemRepoB.create({
        id: generateId(),
        name: 'Tenant B Item',
        recipeGroupId: generateId(),
        price: '3.00',
        priceValidFrom: new Date(),
      });

      const serviceA = new SaleConsumptionService(createScopedDb(client), fixture.tenantA.organizationId);
      const result = await serviceA.recordSaleConsumption({
        storeId: fixture.tenantA.storeId,
        menuItemId: menuItemB.id,
        quantitySold: '1',
        occurredAt: new Date(),
        currency: 'USD',
        sourceType: 'pos-sync',
      });

      expect(result.status).toBe('menu_item_not_found');

      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(menuItems).where(eq(menuItems.id, menuItemB.id));
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects construction with an empty organizationId', () => {
    const db = createScopedDb(client);
    expect(() => new SaleConsumptionService(db, '')).toThrow(/organizationId/);
  });
});
