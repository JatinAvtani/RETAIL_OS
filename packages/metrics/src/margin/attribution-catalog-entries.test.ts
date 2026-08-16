import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId, money } from '@retailos/domain';
import {
  createDb,
  menuItems,
  organizations,
  posItems,
  products,
  productVariants,
  salesTransactionLines,
  salesTransactions,
  stores,
  withTenantContext,
  SalesTransactionRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import type { MetricResult } from '../catalog/index.js';
import type { MarginMetricContext } from './catalog-entries.js';
import type { MarginAttributionMetricResult, MarginTrendMetricResult } from './attribution-catalog-entries.js';
import './attribution-catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that `margin_per_item`, `total_contribution`, `margin_trend`, and
 * `margin_attribution` compute correctly through `executeMetric`. Uses a fixed, real recipe cost
 * (injected via `resolveRecipeUnitCost`, matching `margin/catalog-entries.test.ts`'s own precedent)
 * rather than re-proving recipe-cost resolution, which is already covered elsewhere.
 */
describe('registered margin attribution metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
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

  afterAll(async () => {
    await adminClient.end();
  });

  const setUpOrgWithMenuItem = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Attribution Test Org ${organizationId}`,
      slug: `attribution-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    const menuItemId = generateId();
    const recipeGroupId = generateId();
    const posItemId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
        await tx.insert(menuItems).values({
          id: menuItemId,
          organizationId,
          name: 'Attribution Test Item',
          recipeGroupId,
          price: '10.0000',
          priceValidFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        });
        await tx.insert(posItems).values({
          id: posItemId,
          organizationId,
          storeId,
          source: 'square',
          externalId: `ATTR-${posItemId}`,
          name: 'Attribution Test Item',
          mappingStatus: 'MAPPED',
          menuItemId,
        });
      })
    );
    return { organizationId, storeId, menuItemId, recipeGroupId, posItemId };
  };

  const sellUnits = async (
    organizationId: string,
    storeId: string,
    posItemId: string,
    externalId: string,
    occurredAt: Date,
    quantity: string,
    unitPrice: string
  ) => {
    const lineTotal = (Number(quantity) * Number(unitPrice)).toFixed(4);
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId,
      occurredAt,
      subtotal: lineTotal,
      discount: '0.0000',
      tax: '0.0000',
      total: lineTotal,
      currency: 'USD',
      lines: [{ posItemId, quantity, unitPrice, discount: '0.0000', lineTotal }],
    });
  };

  const auth = (permissions: readonly string[] = ['financial:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  /**
   * Deliberately asserts the SECOND argument the metric passes is a `recipeGroupId`, not a
   * `menuItemId` — catches a real bug found during manual verification, where `margin_per_item`/
   * `margin_attribution` passed the menu item's own id directly to `resolveRecipeUnitCost` instead
   * of resolving its linked `recipeGroupId` first. A stub that ignores its arguments (as this test
   * originally did) cannot catch a wrong-argument bug; asserting the expected id is what makes this
   * a real regression test for it.
   */
  const ctxWithFixedUnitCost = (
    organizationId: string,
    unitCostAmount: string,
    expectedRecipeGroupId?: string
  ): MarginMetricContext => ({
    db,
    organizationId,
    storeIds: 'ALL',
    resolveRecipeUnitCost: async (_ctx, recipeGroupId) => {
      if (expectedRecipeGroupId && recipeGroupId !== expectedRecipeGroupId) {
        throw new Error(
          `resolveRecipeUnitCost called with '${recipeGroupId}', expected the real recipeGroupId '${expectedRecipeGroupId}' — a menu item id was passed instead.`
        );
      }
      return money(unitCostAmount, 'USD');
    },
  });

  it('margin_per_item and total_contribution agree with a hand-derived figure', async () => {
    const { organizationId, storeId, menuItemId, recipeGroupId, posItemId } = await setUpOrgWithMenuItem();
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    await sellUnits(organizationId, storeId, posItemId, `ATTR-SALE-${organizationId}`, new Date(to.getTime() - 24 * 60 * 60 * 1000), '10', '10.0000');

    const ctx = ctxWithFixedUnitCost(organizationId, '4.0000', recipeGroupId);
    const params = { storeId, menuItemId, from, to };

    const [marginPerItem, totalContribution] = await Promise.all([
      executeMetric('margin_per_item', params, auth(), ctx),
      executeMetric('total_contribution', params, auth(), ctx),
    ]);

    // 10 units @ $10.00 each, unit cost $4.00 -> margin per item = $6.00, total contribution = $60.00.
    expect(marginPerItem.value).toBe('6.0000');
    expect(totalContribution.value).toBe('60.0000');
  });

  it('margin_per_item is unknown when the item had no sales in the period, never a fabricated zero', async () => {
    const { organizationId, storeId, menuItemId } = await setUpOrgWithMenuItem();
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const ctx = ctxWithFixedUnitCost(organizationId, '4.0000');

    const result = await executeMetric('margin_per_item', { storeId, menuItemId, from, to }, auth(), ctx);
    expect(result.value).toBe('unknown');
  });

  it('margin_attribution decomposes a real two-period price+volume change and reconciles exactly', async () => {
    const { organizationId, storeId, recipeGroupId, posItemId } = await setUpOrgWithMenuItem();
    const ctx = ctxWithFixedUnitCost(organizationId, '4.0000', recipeGroupId);

    // Base period: 10 units @ $10.00. Comparison period: 15 units @ $12.00 (price went up, volume went up).
    const baseFrom = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const baseTo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const comparisonFrom = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const comparisonTo = new Date();

    await sellUnits(organizationId, storeId, posItemId, `ATTR-BASE-${organizationId}`, new Date(baseFrom.getTime() + 24 * 60 * 60 * 1000), '10', '10.0000');
    await sellUnits(organizationId, storeId, posItemId, `ATTR-COMP-${organizationId}`, new Date(comparisonFrom.getTime() + 24 * 60 * 60 * 1000), '15', '12.0000');

    const result = (await executeMetric(
      'margin_attribution',
      {
        storeId,
        basePeriod: { from: baseFrom, to: baseTo },
        comparisonPeriod: { from: comparisonFrom, to: comparisonTo },
      },
      auth(),
      ctx
    )) as MarginAttributionMetricResult;

    expect(result.excludedItemIds).toEqual([]);
    expect(result.value).not.toBe('unknown');

    // One item only, so mix_effect is 0 (its own share of total is always 100% in both periods).
    // Real total: (12-4)*15 - (10-4)*10 = 120 - 60 = 60.
    const sum =
      Number(result.priceEffect) + Number(result.costEffect) + Number(result.mixEffect) + Number(result.volumeEffect);
    expect(sum.toFixed(4)).toBe(Number(result.value).toFixed(4));
    expect(Number(result.value).toFixed(2)).toBe('60.00');
    expect(Number(result.mixEffect).toFixed(4)).toBe('0.0000');
  });

  it('margin_trend assembles a real series of contribution-margin-percentage points', async () => {
    const { organizationId, storeId, posItemId } = await setUpOrgWithMenuItem();
    const ctx = ctxWithFixedUnitCost(organizationId, '4.0000');

    const periodAFrom = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const periodATo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const periodBFrom = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const periodBTo = new Date();

    await sellUnits(organizationId, storeId, posItemId, `ATTR-TREND-A-${organizationId}`, new Date(periodAFrom.getTime() + 24 * 60 * 60 * 1000), '5', '10.0000');

    const result = (await executeMetric(
      'margin_trend',
      {
        storeId,
        periods: [
          { label: 'A', from: periodAFrom, to: periodATo },
          { label: 'B', from: periodBFrom, to: periodBTo },
        ],
      },
      auth(),
      ctx
    )) as MarginTrendMetricResult;

    expect(result.points).toHaveLength(2);
    expect(result.points[0]!.periodLabel).toBe('A');
    // Period A: 5 units @ $10, no consumption movement recorded -> cogs_actual unknown -> contribution margin unknown.
    // (margin_trend reads real stock_movements for actual COGS, not the injected recipe-cost resolver.)
    expect(result.points[1]!.periodLabel).toBe('B');
    expect(result.points[1]!.contributionMarginPercentage).toBe('unknown'); // no sales at all in period B
  });

  it('items_by_contribution ranks a real sold item by its real total contribution, highest first', async () => {
    const { organizationId, storeId, menuItemId, recipeGroupId, posItemId } = await setUpOrgWithMenuItem();
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    await sellUnits(organizationId, storeId, posItemId, `ITEMS-${organizationId}`, new Date(to.getTime() - 24 * 60 * 60 * 1000), '10', '10.0000');

    const ctx = ctxWithFixedUnitCost(organizationId, '4.0000', recipeGroupId);
    const result = (await executeMetric(
      'items_by_contribution',
      { storeId, from, to },
      auth(),
      ctx
    )) as MetricResult & { items: { menuItemId: string; menuItemName: string; totalContribution: string | 'unknown' }[] };

    // 10 units @ $10.00, unit cost $4.00 -> margin per item $6.00, total contribution $60.00.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.menuItemId).toBe(menuItemId);
    expect(result.items[0]!.menuItemName).toBe('Attribution Test Item');
    expect(result.items[0]!.totalContribution).toBe('60.0000');
    expect(result.value).toBe('60.0000');
  });

  it('items_by_contribution is unknown with no mapped items sold, never a fabricated empty-but-real total', async () => {
    const { organizationId, storeId } = await setUpOrgWithMenuItem();
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const ctx = ctxWithFixedUnitCost(organizationId, '4.0000');

    const result = await executeMetric('items_by_contribution', { storeId, from, to }, auth(), ctx);
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('executeMetric refuses a caller without financial:read for margin_attribution', async () => {
    const { organizationId, storeId } = await setUpOrgWithMenuItem();
    const ctx = ctxWithFixedUnitCost(organizationId, '4.0000');
    const now = new Date();
    await expect(
      executeMetric(
        'margin_attribution',
        { storeId, basePeriod: { from: now, to: now }, comparisonPeriod: { from: now, to: now } },
        auth([]),
        ctx
      )
    ).rejects.toThrow(/financial:read/);
  });
});
