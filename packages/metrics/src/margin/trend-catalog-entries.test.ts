import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId } from '@retailos/domain';
import {
  createDb,
  organizations,
  posItems,
  salesTransactionLines,
  salesTransactions,
  stores,
  withTenantContext,
  SalesTransactionRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import type { MarginMetricContext } from './catalog-entries.js';
import type { FoodCostPercentageTrendMetricResult, NetRevenueTrendMetricResult } from './trend-catalog-entries.js';
import './trend-catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that `net_revenue_trend`/`food_cost_percentage_trend` (earlier work's owner
 * dashboard sparkline input) compute correctly through `executeMetric`, matching `margin_trend`'s
 * own established series shape.
 */
describe('registered margin trend metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
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
      name: `Trend Test Org ${organizationId}`,
      slug: `trend-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    const posItemId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
        await tx.insert(posItems).values({
          id: posItemId,
          organizationId,
          storeId,
          source: 'square',
          externalId: `TREND-${posItemId}`,
          name: 'Trend Test Item',
          mappingStatus: 'UNMAPPED',
        });
      })
    );
    return { organizationId, storeId, posItemId };
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

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });
  const marginCtx = (organizationId: string): MarginMetricContext => ({
    db,
    organizationId,
    storeIds: 'ALL',
    resolveRecipeUnitCost: async () => 'unknown',
  });

  it('net_revenue_trend assembles a real per-period series, each point matching hand-derived revenue', async () => {
    const { organizationId, storeId, posItemId } = await setUpOrg();
    const periodAFrom = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const periodATo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const periodBFrom = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const periodBTo = new Date();

    await sellUnits(organizationId, storeId, posItemId, `TREND-A-${organizationId}`, new Date(periodAFrom.getTime() + 24 * 60 * 60 * 1000), '5', '10.0000');
    await sellUnits(organizationId, storeId, posItemId, `TREND-B-${organizationId}`, new Date(periodBFrom.getTime() + 24 * 60 * 60 * 1000), '8', '10.0000');

    const result = (await executeMetric(
      'net_revenue_trend',
      { storeId, periods: [{ label: 'A', from: periodAFrom, to: periodATo }, { label: 'B', from: periodBFrom, to: periodBTo }] },
      auth(),
      plainCtx(organizationId)
    )) as NetRevenueTrendMetricResult;

    expect(result.points).toHaveLength(2);
    expect(result.points[0]!.value).toBe('50.0000');
    expect(result.points[1]!.value).toBe('80.0000');
    expect(result.value).toBe('80.0000'); // the last point
  });

  it('food_cost_percentage_trend is unknown for a period with no sales, never a fabricated 0%', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const from = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const to = new Date();

    const result = (await executeMetric(
      'food_cost_percentage_trend',
      { storeId, periods: [{ label: 'Only', from, to }] },
      auth(),
      marginCtx(organizationId)
    )) as FoodCostPercentageTrendMetricResult;

    expect(result.points).toHaveLength(1);
    expect(result.points[0]!.value).toBe('unknown');
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('executeMetric refuses a caller without financial:read for net_revenue_trend', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const now = new Date();
    await expect(
      executeMetric('net_revenue_trend', { storeId, periods: [{ label: 'A', from: now, to: now }] }, auth([]), plainCtx(organizationId))
    ).rejects.toThrow(/financial:read/);
  });
});
