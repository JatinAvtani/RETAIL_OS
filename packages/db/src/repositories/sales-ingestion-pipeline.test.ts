import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
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
  unmappedSales,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SalesIngestionPipeline } from './sales-ingestion-pipeline';
import { UnmappedSaleRepository } from './unmapped-sale-repository';
import { MenuItemRepository } from './menu-item-repository';
import { RecipeRepository } from './recipe-repository';
import { ProductRepository } from './product-repository';
import { LotRepository } from './lot-repository';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SalesIngestionPipeline', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let gramUnitId: string;
  let eachUnitId: string;
  let flourId: string;
  let flourVariantId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Sales Ingestion Test Org',
      slug: `sales-ingestion-test-${organizationId}`,
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
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(unmappedSales).where(eq(unmappedSales.organizationId, organizationId));
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
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('quarantines a sale line with menuItemId: null, recording revenue — never dropping the sale', async () => {
    const pipeline = new SalesIngestionPipeline(createScopedDb(client), organizationId);
    const result = await pipeline.ingestSaleLine({
      storeId,
      menuItemId: null,
      posItemExternalId: 'SQ-UNKNOWN-1',
      posItemName: 'Unrecognized Special',
      quantitySold: '1',
      revenue: '12.50',
      currency: 'USD',
      occurredAt: new Date('2026-01-10T18:00:00Z'),
      sourceType: 'pos-sync',
    });

    expect(result.status).toBe('quarantined');
    if (result.status !== 'quarantined') throw new Error('unreachable');

    const unmappedSaleRepo = new UnmappedSaleRepository(createScopedDb(client), organizationId);
    const row = await unmappedSaleRepo.findById(result.unmappedSaleId);
    expect(row?.status).toBe('UNRESOLVED');
    expect(row?.revenue).toBe('12.5000');
    expect(row?.posItemExternalId).toBe('SQ-UNKNOWN-1');

    // No stock_movements row was ever written for this line — consumption genuinely didn't
    // happen (revenue counts, consumption doesn't; nothing silently guessed).
    const adminDb = drizzle(adminClient, { schema });
    const movements = await adminDb
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.organizationId, organizationId));
    expect(movements).toHaveLength(0);
  });

  it('delegates to SaleConsumptionService and posts real consumption when menuItemId is present', async () => {
    const recipeRepo = new RecipeRepository(createScopedDb(client), organizationId);
    const recipeGroupId = generateId();
    await recipeRepo.create({
      id: generateId(),
      recipeGroupId,
      name: 'Simple Bun',
      yieldQuantity: '1',
      yieldUnitId: eachUnitId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ componentType: 'PRODUCT', productId: flourId, quantity: '40', unitId: gramUnitId }],
    });

    const menuItemRepo = new MenuItemRepository(createScopedDb(client), organizationId);
    const menuItem = await menuItemRepo.create({
      id: generateId(),
      name: 'Simple Bun',
      recipeGroupId,
      price: '3.00',
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

    const pipeline = new SalesIngestionPipeline(createScopedDb(client), organizationId);
    const result = await pipeline.ingestSaleLine({
      storeId,
      menuItemId: menuItem.id,
      posItemExternalId: 'SQ-BUN-1',
      posItemName: 'Simple Bun',
      quantitySold: '1',
      revenue: '3.00',
      currency: 'USD',
      occurredAt: new Date('2026-01-02T00:00:00Z'),
      sourceType: 'pos-sync',
    });

    expect(result.status).toBe('consumed');
    if (result.status !== 'consumed') throw new Error('unreachable');
    expect(result.actualCogs !== 'unknown' && result.actualCogs.amount.toString()).toBe('0.08');

    const unmappedSaleRepo = new UnmappedSaleRepository(createScopedDb(client), organizationId);
    const unresolved = await unmappedSaleRepo.findUnresolved(storeId);
    expect(unresolved).toHaveLength(0);
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new SalesIngestionPipeline(createScopedDb(client), '')).toThrow();
  });
});
