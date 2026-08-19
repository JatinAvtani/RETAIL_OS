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
  suppliers,
  supplierProducts,
  supplierPrices,
  units,
  withTenantContext,
  LotRepository,
  MovementService,
  SalesTransactionRepository,
  SupplierPriceRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import type { ConsumptionAnomalyMetricContext } from './catalog-entries.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that all 4 registered anomaly metrics compute correctly
 * through `executeMetric`, using real ledger/sales/price data rather than stubbed repositories.
 */
describe('registered anomaly metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];
  const createdSupplierProductIds: string[] = [];

  afterEach(async () => {
    for (const supplierProductId of createdSupplierProductIds) {
      await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, supplierProductId));
    }
    createdSupplierProductIds.length = 0;
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
      await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await adminDb.delete(products).where(eq(products.organizationId, orgId));
      await adminDb.delete(suppliers).where(eq(suppliers.organizationId, orgId));
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
      name: `Anomaly Metrics Test Org ${organizationId}`,
      slug: `anomaly-metrics-test-${organizationId}`,
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
          sku: `ANOM-${productId}`,
          name: 'Anomaly Metrics Test Product',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
        });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );
    return { productId, variantId, unitId: eachUnit!.id };
  };

  const auth = (permissions: readonly string[] = ['financial:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });
  const consumptionCtx = (organizationId: string): ConsumptionAnomalyMetricContext => ({
    db,
    organizationId,
    storeIds: 'ALL',
    resolveRecipeUnitCost: async () => 'unknown',
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  it('sales_anomaly is unknown with fewer than 14 days of completed sales', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const from = daysAgo(20);
    const to = new Date();
    const result = await executeMetric('sales_anomaly', { storeId, from, to }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('sales_anomaly flags a real, isolated single-day spike against 3 weeks of otherwise-flat real sales', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    // 21 days flat at $50/day, one day (day 10) at $500 — a real, large one-off spike.
    for (let i = 21; i >= 1; i--) {
      const subtotal = i === 10 ? '500.0000' : '50.0000';
      await salesRepo.recordIfNew({
        storeId,
        source: 'square',
        externalId: `ANOM-SALE-${organizationId}-${i}`,
        occurredAt: daysAgo(i),
        subtotal,
        discount: '0.0000',
        tax: '0.0000',
        total: subtotal,
        currency: 'USD',
        lines: [{ quantity: '1.000000', unitPrice: subtotal, discount: '0.0000', lineTotal: subtotal }],
      });
    }

    const from = daysAgo(22);
    const to = new Date();
    const result = await executeMetric('sales_anomaly', { storeId, from, to }, auth(), plainCtx(organizationId));
    expect(result.value).not.toBe('unknown');
    expect(Number(result.value)).toBeGreaterThan(0);
    const anomalyResult = result as typeof result & { anomalies: { date: string }[] };
    expect(anomalyResult.anomalies.length).toBeGreaterThan(0);
  });

  it('cost_spike is unknown with fewer than 2 historical price points', async () => {
    const { organizationId } = await setUpOrg();
    const supplierId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () => tx.insert(suppliers).values({ id: supplierId, organizationId, name: 'Cost Spike Supplier' }))
    );
    const { productId } = await makeProduct(organizationId);
    const supplierProductId = generateId();
    createdSupplierProductIds.push(supplierProductId);
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: 'SKU-1', isConfirmed: true })
      )
    );
    const supplierPriceRepository = new SupplierPriceRepository(db, organizationId);
    await supplierPriceRepository.recordNewPrice({
      id: generateId(),
      supplierProductId,
      unitPrice: '5.0000',
      currency: 'USD',
      validFrom: daysAgo(30),
    });

    const result = await executeMetric('cost_spike', { supplierProductId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
  });

  it('cost_spike flags a real >15% price jump against trailing history', async () => {
    const { organizationId } = await setUpOrg();
    const supplierId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () => tx.insert(suppliers).values({ id: supplierId, organizationId, name: 'Cost Spike Supplier 2' }))
    );
    const { productId } = await makeProduct(organizationId);
    const supplierProductId = generateId();
    createdSupplierProductIds.push(supplierProductId);
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: 'SKU-2', isConfirmed: true })
      )
    );
    const supplierPriceRepository = new SupplierPriceRepository(db, organizationId);
    // 4 real prices at $5.00, then a real jump to $6.50 (+30%).
    await supplierPriceRepository.recordNewPrice({ id: generateId(), supplierProductId, unitPrice: '5.0000', currency: 'USD', validFrom: daysAgo(40) });
    await supplierPriceRepository.recordNewPrice({ id: generateId(), supplierProductId, unitPrice: '5.0000', currency: 'USD', validFrom: daysAgo(30) });
    await supplierPriceRepository.recordNewPrice({ id: generateId(), supplierProductId, unitPrice: '5.0000', currency: 'USD', validFrom: daysAgo(20) });
    await supplierPriceRepository.recordNewPrice({ id: generateId(), supplierProductId, unitPrice: '6.5000', currency: 'USD', validFrom: daysAgo(1) });

    const result = await executeMetric('cost_spike', { supplierProductId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('1');
    const anomalyResult = result as typeof result & { anomalies: { value: string }[] };
    expect(anomalyResult.anomalies[0]!.value).toBe('30.00');
  });

  it('waste_spike is unknown with fewer than 2 days of waste', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const from = daysAgo(10);
    const to = new Date();
    const result = await executeMetric('waste_spike', { storeId, from, to }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('unknown');
  });

  it('waste_spike flags a real day whose waste value is a statistical outlier', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const lotRepo = new LotRepository(db, organizationId);
    const movements = new MovementService(db, organizationId);
    const lotId = generateId();
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt: daysAgo(10),
      initialQuantity: '1000.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });
    // 6 days of small waste ($10/day), one day ($80) — a real outlier, hand-verified z ~ 2.449 > 2.
    for (let i = 7; i >= 2; i--) {
      await movements.postMovement({
        storeId,
        productId,
        variantId,
        lotId,
        movementType: 'WASTE',
        quantity: '-10.000000',
        unitCost: '1.0000',
        currency: 'USD',
        occurredAt: daysAgo(i),
        sourceType: 'test',
        reasonCode: 'SPILLAGE',
      });
    }
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'WASTE',
      quantity: '-80.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: daysAgo(1),
      sourceType: 'test',
      reasonCode: 'SPILLAGE',
    });

    const from = daysAgo(8);
    const to = new Date();
    const result = await executeMetric('waste_spike', { storeId, from, to }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('1');
  });

  it('consumption_anomaly is unknown-free real zero with no sustained divergence', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const from = daysAgo(10);
    const to = new Date();
    const result = await executeMetric(
      'consumption_anomaly',
      { storeId, from, to },
      auth(),
      consumptionCtx(organizationId)
    );
    expect(result.value).toBe('0');
  });

  it('executeMetric refuses a caller without financial:read for an anomaly metric', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const from = daysAgo(10);
    const to = new Date();
    await expect(
      executeMetric('waste_spike', { storeId, from, to }, auth([]), plainCtx(organizationId))
    ).rejects.toThrow(/financial:read/);
  });
});
