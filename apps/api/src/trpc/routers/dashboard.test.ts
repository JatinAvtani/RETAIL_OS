import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  createDb,
  categories,
  lots,
  menuItems,
  organizations,
  outboxEvents,
  posItems,
  productVariants,
  products,
  recipeComponents,
  recipes,
  salesTransactionLines,
  salesTransactions,
  stockLevels,
  stockMovements,
  stores,
  supplierPrices,
  supplierProducts,
  suppliers,
  units,
  unmappedSales,
  LotRepository,
  MovementService,
  SalesTransactionRepository,
} from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * Real HTTP verification for the owner dashboard. The figures asserted here are hand-derived from
 * the seeded rows, independently of the implementation — a dashboard that agrees with itself but
 * not with arithmetic is the failure mode these tests exist to catch.
 */
describe('dashboard.summary', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sessionStore = new SessionStore(redis);
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await db.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await db.delete(lots).where(eq(lots.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(unmappedSales).where(eq(unmappedSales.organizationId, orgId));
      await db.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await db.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await db.delete(posItems).where(eq(posItems.organizationId, orgId));
      await db.delete(menuItems).where(eq(menuItems.organizationId, orgId));

      const orgRecipes = await db.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await db.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await db.delete(recipes).where(eq(recipes.organizationId, orgId));

      const orgSupplierProducts = await db
        .select({ id: supplierProducts.id })
        .from(supplierProducts)
        .where(eq(supplierProducts.organizationId, orgId));
      for (const sp of orgSupplierProducts) {
        await db.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, sp.id));
      }
      await db.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));

      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(categories).where(eq(categories.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Dashboard Test Org ${organizationId}`,
      slug: `dashboard-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const issueSession = async (organizationId: string): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    // dashboard.summary now resolves every figure through the metric catalog (009-02), which
    // enforces each metric's requiredPermission ('financial:read' for every margin metric) before
    // executing — a real OWNER session carries this via ROLE_PERMISSIONS, so the fixture must too.
    const { token } = await sessionStore.create(
      { userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions: ['financial:read'] },
      '127.0.0.1',
      'test-agent'
    );
    return token;
  };

  const fetchSummary = async (storeId: string, cookie: string, days = 30) => {
    const response = await app.inject({
      method: 'GET',
      url: `/trpc/dashboard.summary?input=${encodeURIComponent(JSON.stringify({ storeId, days }))}`,
      cookies: { '__Host-session': cookie },
    });
    return response;
  };

  it('rejects a request with no session cookie (401)', async () => {
    const { storeId } = await setUpOrg();
    const response = await app.inject({
      method: 'GET',
      url: `/trpc/dashboard.summary?input=${encodeURIComponent(JSON.stringify({ storeId, days: 30 }))}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('an org with no data returns real zeros for revenue but unknown for the ratios', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const cookie = await issueSession(organizationId);

    const response = await fetchSummary(storeId, cookie);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;

    // No sales genuinely means zero revenue — a real, knowable zero.
    expect(Number(body.netRevenue.amount)).toBe(0);
    expect(body.transactionCount).toBe(0);
    // But a food cost percentage over zero revenue is undefined, not 0% — 0% would read as
    // flawless cost control rather than "nothing happened".
    expect(body.foodCostPercentage).toBeNull();
    expect(body.averageTransactionValue).toBeNull();
  });

  it('computes revenue, actual COGS, margin and food cost from real rows', async () => {
    const { organizationId, storeId } = await setUpOrg();

    // One product, received at a known cost, then partially consumed.
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    await db.insert(products).values({
      id: productId,
      organizationId,
      sku: `DASH-${productId}`,
      name: 'Test Ingredient',
      baseUnitId: eachUnit!.id,
      type: 'INGREDIENT',
    });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });

    const lotRepo = new LotRepository(db, organizationId);
    const lot = await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      initialQuantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });

    const movements = new MovementService(db, organizationId);
    // 10 units consumed at $2.00 each = $20.00 actual COGS.
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId: lot.id,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-10.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });

    // Revenue: 2 transactions of $60 and $40 = $100.
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    for (const [i, total] of [['a', '60.0000'], ['b', '40.0000']] as const) {
      await salesRepo.recordIfNew({
        storeId,
        source: 'square',
        externalId: `DASH-ORDER-${i}-${organizationId}`,
        occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        subtotal: total,
        discount: '0.0000',
        tax: '0.0000',
        total,
        currency: 'USD',
        lines: [{ quantity: '1.000000', unitPrice: total, discount: '0.0000', lineTotal: total }],
      });
    }

    const cookie = await issueSession(organizationId);
    const body = JSON.parse((await fetchSummary(storeId, cookie)).body).result.data;

    expect(Number(body.netRevenue.amount)).toBe(100);
    expect(body.transactionCount).toBe(2);
    expect(Number(body.cogsActual.amount)).toBe(20);
    // margin = 100 - 20 = 80, which is 80% of revenue; food cost = 20/100 = 20%.
    expect(Number(body.contributionMargin.amount)).toBe(80);
    expect(body.contributionMarginPercentage).toBe(80);
    expect(body.foodCostPercentage).toBe(20);
    expect(Number(body.averageTransactionValue.amount)).toBe(50);
  });

  it('a consumption event with no recorded lot cost makes COGS and every derived figure unknown, never zero', async () => {
    const { organizationId, storeId } = await setUpOrg();

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    await db.insert(products).values({
      id: productId,
      organizationId,
      sku: `DASH-U-${productId}`,
      name: 'Uncosted Ingredient',
      baseUnitId: eachUnit!.id,
      type: 'INGREDIENT',
    });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });

    // A consumption movement written directly with NO unit cost — the real shape of stock that
    // moved before anyone recorded what it cost.
    await db.insert(stockMovements).values({
      id: generateId(),
      organizationId,
      storeId,
      productId,
      variantId,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-5.000000',
      unitCost: null,
      currency: 'USD',
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      recordedAt: new Date(),
      sourceType: 'test',
    });

    const salesRepo = new SalesTransactionRepository(db, organizationId);
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `DASH-UNKNOWN-${organizationId}`,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      subtotal: '50.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '50.0000',
      currency: 'USD',
      lines: [{ quantity: '1.000000', unitPrice: '50.0000', discount: '0.0000', lineTotal: '50.0000' }],
    });

    const cookie = await issueSession(organizationId);
    const body = JSON.parse((await fetchSummary(storeId, cookie)).body).result.data;

    // Revenue is still known and reported.
    expect(Number(body.netRevenue.amount)).toBe(50);
    // But everything downstream of the unknown cost refuses to state a figure.
    expect(body.cogsActual).toBeNull();
    expect(body.contributionMargin).toBeNull();
    expect(body.foodCostPercentage).toBeNull();
    expect(body.costVariance.value).toBeNull();
    expect(body.costVariance.direction).toBe('unknown');
    // And the reason is surfaced rather than left mysterious.
    expect(body.completeness.unknownCostConsumptionEvents).toBe(1);
  });

  it('waste is grouped by reason code, biggest first', async () => {
    const { organizationId, storeId } = await setUpOrg();

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    await db.insert(products).values({
      id: productId,
      organizationId,
      sku: `DASH-W-${productId}`,
      name: 'Wasted Ingredient',
      baseUnitId: eachUnit!.id,
      type: 'INGREDIENT',
    });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });

    const wasteEvents = [
      { reason: 'SPILLAGE', qty: '-2.000000', cost: '1.5000' }, // 3.00
      { reason: 'EXPIRED', qty: '-10.000000', cost: '1.5000' }, // 15.00
      { reason: 'SPILLAGE', qty: '-1.000000', cost: '1.5000' }, // 1.50 -> spillage total 4.50
    ];
    for (const event of wasteEvents) {
      await db.insert(stockMovements).values({
        id: generateId(),
        organizationId,
        storeId,
        productId,
        variantId,
        movementType: 'WASTE',
        quantity: event.qty,
        unitCost: event.cost,
        currency: 'USD',
        occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        recordedAt: new Date(),
        sourceType: 'test',
        reasonCode: event.reason,
      });
    }

    const cookie = await issueSession(organizationId);
    const body = JSON.parse((await fetchSummary(storeId, cookie)).body).result.data;

    // EXPIRED 10 x $1.50 = $15.00; SPILLAGE (2 + 1) x $1.50 = $4.50; total $19.50.
    expect(Number(body.waste.total.amount)).toBe(19.5);
    expect(body.waste.byReason.map((r: { reasonCode: string }) => r.reasonCode)).toEqual([
      'EXPIRED',
      'SPILLAGE',
    ]);
    expect(Number(body.waste.byReason[0].value)).toBe(15);
    expect(Number(body.waste.byReason[1].value)).toBe(4.5);
  });

  it('excludes movements outside the requested period', async () => {
    const { organizationId, storeId } = await setUpOrg();

    const salesRepo = new SalesTransactionRepository(db, organizationId);
    // One sale inside a 7-day window, one well outside it.
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `DASH-RECENT-${organizationId}`,
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      subtotal: '10.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '10.0000',
      currency: 'USD',
      lines: [{ quantity: '1.000000', unitPrice: '10.0000', discount: '0.0000', lineTotal: '10.0000' }],
    });
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `DASH-OLD-${organizationId}`,
      occurredAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      subtotal: '999.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '999.0000',
      currency: 'USD',
      lines: [{ quantity: '1.000000', unitPrice: '999.0000', discount: '0.0000', lineTotal: '999.0000' }],
    });

    const cookie = await issueSession(organizationId);
    const body = JSON.parse((await fetchSummary(storeId, cookie, 7)).body).result.data;

    expect(Number(body.netRevenue.amount)).toBe(10);
    expect(body.transactionCount).toBe(1);
  });

  /**
   * Regression test for a real bug: `computeRecipeCost` returns the cost of a whole BATCH, but
   * theoretical COGS needs the cost of ONE unit. Multiplying batch cost by units sold overstated
   * theoretical COGS by the yield factor — invisible on screen, because the wrong figure still
   * looks like money. This test pins the division by constructing a recipe with a yield of 10 and
   * asserting the per-unit arithmetic explicitly.
   */
  it('divides batch recipe cost by yield when computing theoretical COGS', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const unitId = eachUnit!.id;

    // One ingredient at a known, confirmed supplier price: $10 per pack of 10 = $1.00 per unit.
    const productId = generateId();
    await db.insert(products).values({
      id: productId,
      organizationId,
      sku: `DASH-Y-${productId}`,
      name: 'Yield Test Ingredient',
      baseUnitId: unitId,
      type: 'INGREDIENT',
    });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });

    const supplierId = generateId();
    await db.insert(suppliers).values({ id: supplierId, organizationId, name: 'Yield Test Supplier' });
    const supplierProductId = generateId();
    await db.insert(supplierProducts).values({
      id: supplierProductId,
      organizationId,
      supplierId,
      productId,
      supplierSku: 'YT-1',
      packSize: '10',
      packUnitId: unitId,
      conversionToBase: '10',
      isConfirmed: true,
    });
    await db.insert(supplierPrices).values({
      id: generateId(),
      supplierProductId,
      unitPrice: '10.0000',
      currency: 'USD',
      validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    // Recipe: 20 units of the ingredient, yielding 10 portions.
    // Batch cost = 20 x $1.00 = $20.00 → per-portion cost = $2.00.
    const recipeGroupId = generateId();
    const recipeId = generateId();
    await db.insert(recipes).values({
      id: recipeId,
      recipeGroupId,
      organizationId,
      name: 'Yield Test Recipe',
      yieldQuantity: '10',
      yieldUnitId: unitId,
      validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    await db.insert(recipeComponents).values({
      id: generateId(),
      recipeId,
      componentType: 'PRODUCT',
      productId,
      quantity: '20',
      unitId,
    });

    const menuItemId = generateId();
    await db.insert(menuItems).values({
      id: menuItemId,
      organizationId,
      name: 'Yield Test Item',
      recipeGroupId,
      price: '5.0000',
      priceValidFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const posItemId = generateId();
    await db.insert(posItems).values({
      id: posItemId,
      organizationId,
      storeId,
      source: 'square',
      externalId: `YT-${posItemId}`,
      name: 'Yield Test Item',
      mappingStatus: 'MAPPED',
      menuItemId,
    });

    // Sell 7 portions.
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `DASH-YIELD-${organizationId}`,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      subtotal: '35.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '35.0000',
      currency: 'USD',
      lines: [
        { posItemId, quantity: '7.000000', unitPrice: '5.0000', discount: '0.0000', lineTotal: '35.0000' },
      ],
    });

    const cookie = await issueSession(organizationId);
    const body = JSON.parse((await fetchSummary(storeId, cookie)).body).result.data;

    // 7 portions x $2.00 per portion = $14.00.
    // The bug produced 7 x $20.00 = $140.00 — a 10x overstatement, exactly the yield factor.
    expect(Number(body.cogsTheoretical.amount)).toBe(14);
  });

  it("one org's data never appears in another org's dashboard", async () => {
    const { organizationId: orgA, storeId: storeA } = await setUpOrg();
    const { organizationId: orgB } = await setUpOrg();

    const salesRepo = new SalesTransactionRepository(db, orgA);
    await salesRepo.recordIfNew({
      storeId: storeA,
      source: 'square',
      externalId: `DASH-XT-${orgA}`,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      subtotal: '500.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '500.0000',
      currency: 'USD',
      lines: [{ quantity: '1.000000', unitPrice: '500.0000', discount: '0.0000', lineTotal: '500.0000' }],
    });

    // Tenant B attacking tenant A's store id gets a 404, not tenant A's numbers.
    const cookieB = await issueSession(orgB);
    const response = await fetchSummary(storeA, cookieB);
    expect(response.statusCode).toBe(404);
  });
});
