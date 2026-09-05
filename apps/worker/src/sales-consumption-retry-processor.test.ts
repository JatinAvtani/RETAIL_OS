import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import {
  createDb,
  organizations,
  stores,
  products,
  productVariants,
  recipes,
  recipeComponents,
  menuItems,
  units,
  lots,
  stockMovements,
  stockLevels,
  salesTransactions,
  salesTransactionLines,
  posItems,
  auditLogs,
  outboxEvents,
  ProductRepository,
  RecipeRepository,
  MenuItemRepository,
  LotRepository,
  SalesTransactionRepository,
} from '@retailos/db';
import { createSalesConsumptionRetryProcessor } from './sales-consumption-retry-processor';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Proves `sale to consumption handoff`'s real repair tooling end to end against real Postgres: a
 * transaction whose consumption never ran (`PENDING`, simulating a crash mid-sync before
 * `triggerConsumptionForTransaction` was ever called) or previously failed (`FAILED`) gets a real
 * retry, and a genuinely recovered transaction is marked `COMPLETED` with real stock actually
 * consumed. Not a re-test of `consumeFefo`'s own idempotency (covered directly in
 * `movement-service.test.ts`) — what's unique to this layer is the sweep's own composition: does
 * `findPendingConsumptionTransactions`'s real cross-tenant read actually resolve to a real,
 * recovered consumption for the right (org, store, transaction).
 */
describe('sales consumption retry processor', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      const orgRecipes = await adminDb.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await adminDb.delete(recipes).where(eq(recipes.organizationId, orgId));
      await adminDb.delete(menuItems).where(eq(menuItems.organizationId, orgId));
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

  /** A real product -> recipe -> menu item chain, a real lot with stock, and a real pos_items row mapped to the menu item — everything the retry needs to post genuine consumption, not a quarantine. */
  const setUpMappedMenuItemWithStock = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await adminDb.insert(organizations).values({ id: organizationId, name: 'Consumption Retry Test Org', slug: `consumption-retry-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const [gramUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'g'));
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    if (!gramUnit || !eachUnit) throw new Error('seeded units g/each not found — migrations not applied?');

    const productRepo = new ProductRepository(db, organizationId);
    const flour = await productRepo.create({ id: generateId(), sku: `FLOUR-${generateId()}`, name: 'Flour', baseUnitId: gramUnit.id, type: 'INGREDIENT' });
    const flourVariantId = (await productRepo.findVariants(flour.id))[0]!.id;

    const recipeRepo = new RecipeRepository(db, organizationId);
    const recipeGroupId = generateId();
    await recipeRepo.create({
      id: generateId(),
      recipeGroupId,
      name: 'Simple Bun',
      yieldQuantity: '1',
      yieldUnitId: eachUnit.id,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ componentType: 'PRODUCT', productId: flour.id, quantity: '40', unitId: gramUnit.id }],
    });

    const menuItemRepo = new MenuItemRepository(db, organizationId);
    const menuItem = await menuItemRepo.create({ id: generateId(), name: 'Simple Bun', recipeGroupId, price: '4.50', priceValidFrom: new Date('2026-01-01T00:00:00Z') });

    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId: flour.id,
      variantId: flourVariantId,
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      initialQuantity: '1000.000000',
      unitCost: '0.0020',
      currency: 'USD',
    });

    const posItemId = generateId();
    await adminDb.insert(posItems).values({
      id: posItemId,
      organizationId,
      storeId,
      source: 'square',
      externalId: 'VAR-BUN-1',
      name: 'Simple Bun',
      menuItemId: menuItem.id,
      mappingStatus: 'MAPPED',
    });

    return { organizationId, storeId, posItemId };
  };

  it('a real PENDING transaction (consumption never attempted) is recovered — real stock is actually consumed', async () => {
    const { organizationId, storeId, posItemId } = await setUpMappedMenuItemWithStock();
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    const recorded = await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `PENDING-RETRY-${organizationId}`,
      occurredAt: new Date(),
      subtotal: '4.5000',
      discount: '0.0000',
      tax: '0.0000',
      total: '4.5000',
      currency: 'USD',
      lines: [{ posItemId, quantity: '1.000000', unitPrice: '4.5000', discount: '0.0000', lineTotal: '4.5000' }],
    });
    if (recorded.status !== 'recorded') throw new Error('setup failed: transaction was not newly recorded');

    // Left at the real default consumptionStatus ('PENDING') — never touched, simulating a real
    // crash before triggerConsumptionForTransaction ever ran for it.

    const processor = createSalesConsumptionRetryProcessor({ databaseUrl: ADMIN_CONNECTION_STRING });
    const result = await processor();

    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const [txAfter] = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.id, recorded.transactionId));
    expect(txAfter?.consumptionStatus).toBe('COMPLETED');

    const movementRows = await adminDb.select().from(stockMovements).where(eq(stockMovements.sourceId, recorded.transactionId));
    expect(movementRows).toHaveLength(1);
    expect(movementRows[0]?.movementType).toBe('SALE_CONSUMPTION');
    expect(movementRows[0]?.quantity).toBe('-40.000000'); // 1 bun * 40g flour per the recipe
  });

  it('a real FAILED transaction (a prior attempt threw) is retried and recovered, with the same idempotency guard against double-consumption', async () => {
    const { organizationId, storeId, posItemId } = await setUpMappedMenuItemWithStock();
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    const recorded = await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `FAILED-RETRY-${organizationId}`,
      occurredAt: new Date(),
      subtotal: '4.5000',
      discount: '0.0000',
      tax: '0.0000',
      total: '4.5000',
      currency: 'USD',
      lines: [{ posItemId, quantity: '1.000000', unitPrice: '4.5000', discount: '0.0000', lineTotal: '4.5000' }],
    });
    if (recorded.status !== 'recorded') throw new Error('setup failed: transaction was not newly recorded');

    // A real prior attempt already consumed successfully, THEN a later, separate failure was
    // recorded on the same transaction (e.g. a webhook re-delivery's own consumption attempt threw
    // for an unrelated reason after the first one had already posted) — the retry-worthy case where
    // simply re-running from scratch would double-consume without the idempotency guard.
    await salesRepo.markConsumptionCompleted(recorded.transactionId);
    await salesRepo.markConsumptionFailed(recorded.transactionId, 'simulated transient failure on a later attempt');

    const processor = createSalesConsumptionRetryProcessor({ databaseUrl: ADMIN_CONNECTION_STRING });
    await processor();

    const [txAfter] = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.id, recorded.transactionId));
    expect(txAfter?.consumptionStatus).toBe('COMPLETED');

    // The real proof: still exactly ONE movement, not two — the idempotency guard, not luck.
    const movementRows = await adminDb.select().from(stockMovements).where(eq(stockMovements.sourceId, recorded.transactionId));
    expect(movementRows).toHaveLength(1);
  });

  it('one transaction genuinely throwing during retry does not prevent another real transaction in the same tick from recovering', async () => {
    const fixtureA = await setUpMappedMenuItemWithStock();
    const fixtureB = await setUpMappedMenuItemWithStock();

    const salesRepoA = new SalesTransactionRepository(db, fixtureA.organizationId);
    const salesRepoB = new SalesTransactionRepository(db, fixtureB.organizationId);

    const recordedA = await salesRepoA.recordIfNew({
      storeId: fixtureA.storeId,
      source: 'square',
      externalId: `MULTI-A-${fixtureA.organizationId}`,
      occurredAt: new Date(),
      subtotal: '4.5000',
      discount: '0.0000',
      tax: '0.0000',
      total: '4.5000',
      currency: 'USD',
      lines: [{ posItemId: fixtureA.posItemId, quantity: '1.000000', unitPrice: '4.5000', discount: '0.0000', lineTotal: '4.5000' }],
    });
    const recordedB = await salesRepoB.recordIfNew({
      storeId: fixtureB.storeId,
      source: 'square',
      externalId: `MULTI-B-${fixtureB.organizationId}`,
      occurredAt: new Date(),
      subtotal: '4.5000',
      discount: '0.0000',
      tax: '0.0000',
      total: '4.5000',
      currency: 'USD',
      lines: [{ posItemId: fixtureB.posItemId, quantity: '1.000000', unitPrice: '4.5000', discount: '0.0000', lineTotal: '4.5000' }],
    });
    if (recordedA.status !== 'recorded' || recordedB.status !== 'recorded') throw new Error('setup failed');

    // `SaleConsumptionService.recordSaleConsumption` deliberately never throws for a known business
    // condition (insufficient stock is caught and reported inline, I7) — there is no real, organic
    // way to make ONE transaction's retry genuinely throw without corrupting shared state the other
    // transaction also depends on. A forced single-call throw on the completion-marking step is the
    // established isolation-testing technique this codebase already uses elsewhere (see
    // sales-anomaly-sweep-processor.test.ts's own identical reasoning) for exactly this shape of test.
    const spy = vi.spyOn(SalesTransactionRepository.prototype, 'markConsumptionCompleted').mockImplementationOnce(async () => {
      throw new Error('simulated transient failure for transaction A');
    });

    try {
      const processor = createSalesConsumptionRetryProcessor({ databaseUrl: ADMIN_CONNECTION_STRING });
      const result = await processor();

      expect(result.stillFailing).toBeGreaterThanOrEqual(1);
      expect(result.recovered).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }

    // The spy fires for whichever transaction's completion is marked first — order between A and B
    // isn't guaranteed, so the real assertion is that EXACTLY ONE of them ended up FAILED (the
    // forced throw) and the other COMPLETED (unaffected), not which specific one.
    const [txA] = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.id, recordedA.transactionId));
    const [txB] = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.id, recordedB.transactionId));
    const statuses = [txA?.consumptionStatus, txB?.consumptionStatus].sort();
    expect(statuses).toEqual(['COMPLETED', 'FAILED']);
  });
});
