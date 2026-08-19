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
import type { RevenuePerDaypartMetricResult, SalesMixMetricResult } from './catalog-entries.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that the 8 newly-registered sales metrics compute correctly
 * through `executeMetric`. `net_revenue` (also the design) is already covered by
 * `margin/catalog-entries.test.ts` — not re-tested here.
 */
describe('registered sales metrics', () => {
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

  const setUpOrg = async (timezone = 'America/New_York') => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Sales Metrics Test Org ${organizationId}`,
      slug: `sales-metrics-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone })
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

  const ctxFor = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });

  it('gross_revenue/transaction_count/average_transaction_value/units_sold agree with hand-derived figures', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const salesRepo = new SalesTransactionRepository(db, organizationId);

    // Two completed sales: $60 (with a $6 discount, so net line total is $54) and $40 (no discount).
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `SM-A-${organizationId}`,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      subtotal: '60.0000',
      discount: '6.0000',
      tax: '0.0000',
      total: '54.0000',
      currency: 'USD',
      lines: [{ quantity: '2.000000', unitPrice: '30.0000', discount: '6.0000', lineTotal: '54.0000' }],
    });
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `SM-B-${organizationId}`,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      subtotal: '40.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '40.0000',
      currency: 'USD',
      lines: [{ quantity: '1.000000', unitPrice: '40.0000', discount: '0.0000', lineTotal: '40.0000' }],
    });

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const params = { storeId, from, to };
    const ctx = ctxFor(organizationId);

    const [grossRevenue, transactionCount, avgTxnValue, unitsSold, discountRate] = await Promise.all([
      executeMetric('gross_revenue', params, auth(), ctx),
      executeMetric('transaction_count', params, auth(), ctx),
      executeMetric('average_transaction_value', params, auth(), ctx),
      executeMetric('units_sold', params, auth(), ctx),
      executeMetric('discount_rate', params, auth(), ctx),
    ]);

    // Gross = 60 + 40 = 100.
    expect(grossRevenue.value).toBe('100.0000');
    expect(transactionCount.value).toBe('2');
    // Net = 54 + 40 = 94; 94 / 2 = 47.
    expect(avgTxnValue.value).toBe('47.0000');
    // 2 + 1 = 3 units.
    expect(unitsSold.value).toBe('3.000000');
    // discount 6 / gross 100 = 6%.
    expect(discountRate.value).toBe('6.00');
  });

  it('refund_rate is computed from a real REFUNDED transaction against completed gross revenue', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const salesRepo = new SalesTransactionRepository(db, organizationId);

    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `SM-REFUND-BASE-${organizationId}`,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      subtotal: '200.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '200.0000',
      currency: 'USD',
      lines: [{ quantity: '1.000000', unitPrice: '200.0000', discount: '0.0000', lineTotal: '200.0000' }],
    });

    // A real REFUNDED transaction, written directly since recordIfNew only ever creates COMPLETED rows.
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(salesTransactions).values({
          id: generateId(),
          organizationId,
          storeId,
          source: 'square',
          externalId: `SM-REFUND-${organizationId}`,
          occurredAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
          subtotal: '50.0000',
          discount: '0.0000',
          tax: '0.0000',
          total: '50.0000',
          currency: 'USD',
          status: 'REFUNDED',
        })
      )
    );

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const result = await executeMetric(
      'refund_rate',
      { storeId, from, to },
      auth(),
      ctxFor(organizationId)
    );

    // 50 / 200 = 25%.
    expect(result.value).toBe('25.00');
  });

  it('discount_rate and refund_rate are unknown at zero gross revenue, never a fabricated 0%', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const params = { storeId, from, to };
    const ctx = ctxFor(organizationId);

    const [discountRate, refundRate] = await Promise.all([
      executeMetric('discount_rate', params, auth(), ctx),
      executeMetric('refund_rate', params, auth(), ctx),
    ]);

    expect(discountRate.value).toBe('unknown');
    expect(refundRate.value).toBe('unknown');
  });

  it('sales_mix_percentage groups revenue by real POS item, biggest first', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const salesRepo = new SalesTransactionRepository(db, organizationId);

    const croissantItemId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(posItems).values({
          id: croissantItemId,
          organizationId,
          storeId,
          source: 'square',
          externalId: `SM-MIX-CROISSANT-${organizationId}`,
          name: 'Croissant',
          mappingStatus: 'UNMAPPED',
        })
      )
    );

    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `SM-MIX-${organizationId}`,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      subtotal: '100.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '100.0000',
      currency: 'USD',
      lines: [
        { posItemId: croissantItemId, quantity: '3.000000', unitPrice: '25.0000', discount: '0.0000', lineTotal: '75.0000' },
        { quantity: '1.000000', unitPrice: '25.0000', discount: '0.0000', lineTotal: '25.0000' },
      ],
    });

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const result = (await executeMetric(
      'sales_mix_percentage',
      { storeId, from, to },
      auth(),
      ctxFor(organizationId)
    )) as SalesMixMetricResult;

    expect(result.mix).toHaveLength(2);
    expect(result.mix[0]!.itemId).toBe(croissantItemId);
    expect(result.mix[0]!.percentage).toBe(75);
    const unmapped = result.mix.find((m) => m.itemId === null);
    expect(unmapped?.percentage).toBe(25);
  });

  it('revenue_per_daypart buckets by real STORE-LOCAL time, not UTC', async () => {
    const { organizationId, storeId } = await setUpOrg('America/New_York');
    const salesRepo = new SalesTransactionRepository(db, organizationId);

    // 2026-06-01 17:00 UTC = 13:00 New York (LUNCH, daylight saving UTC-4).
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `SM-DAYPART-LUNCH-${organizationId}`,
      occurredAt: new Date('2026-06-01T17:00:00.000Z'),
      subtotal: '40.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '40.0000',
      currency: 'USD',
      lines: [{ quantity: '1.000000', unitPrice: '40.0000', discount: '0.0000', lineTotal: '40.0000' }],
    });

    const result = (await executeMetric(
      'revenue_per_daypart',
      { storeId, from: new Date('2026-05-01T00:00:00.000Z'), to: new Date('2026-07-01T00:00:00.000Z') },
      auth(),
      ctxFor(organizationId)
    )) as RevenuePerDaypartMetricResult;

    expect(result.byDaypart.LUNCH).toBe('40.0000');
    expect(result.byDaypart.BREAKFAST).toBe('0.0000');
    expect(result.byDaypart.DINNER).toBe('0.0000');
    expect(result.byDaypart.LATE_NIGHT).toBe('0.0000');
    // value is the sum across all four dayparts, which equals the period's net revenue.
    expect(result.value).toBe('40.0000');
  });

  it('executeMetric refuses a caller without financial:read for a sales metric', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

    await expect(
      executeMetric('gross_revenue', { storeId, from, to }, auth([]), ctxFor(organizationId))
    ).rejects.toThrow(/financial:read/);
  });
});
