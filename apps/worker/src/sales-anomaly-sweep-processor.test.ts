import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId, buildSalesAnomalyDedupKey } from '@retailos/domain';
import {
  createDb,
  withTenantContext,
  organizations,
  stores,
  salesTransactions,
  salesTransactionLines,
  notifications,
  notificationRules,
  notificationDeliveries,
  notificationPreferences,
  memberships,
  users,
  SalesTransactionRepository,
  NotificationRepository,
} from '@retailos/db';
import { createSalesAnomalySweepProcessor } from './sales-anomaly-sweep-processor';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/**
 * Proves `sales_anomaly`'s real trigger end to end against real Postgres: the sweep calls the
 * ALREADY-REGISTERED `sales_anomaly` metric (proven correct in isolation by
 * `packages/metrics/src/anomaly/catalog-entries.test.ts`) under a synthetic auth context, and turns
 * a real flagged day into a real database write. Not a re-test of the statistical decomposition
 * itself — what's unique to this layer is the sweep's own composition: does a real flagged day
 * actually resolve to one real notification, does a second sweep tick not double-notify, and does
 * a day falling OUT of the flagged set correctly resolve its notification.
 */
describe('sales anomaly sweep processor', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, orgId));
      await adminDb.delete(notifications).where(eq(notifications.organizationId, orgId));
      await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      await adminDb.delete(notificationPreferences).where(eq(notificationPreferences.organizationId, orgId));
      const orgMemberships = await adminDb.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.organizationId, orgId));
      await adminDb.delete(memberships).where(eq(memberships.organizationId, orgId));
      for (const m of orgMemberships) {
        await adminDb.delete(users).where(eq(users.id, m.userId));
      }
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  const setUpOrgStore = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Sales Anomaly Test Org', slug: `sales-anomaly-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Sales Anomaly Store', status: 'active', timezone: 'UTC' })
      )
    );
    return { organizationId, storeId };
  };

  /** The exact real fixture `catalog-entries.test.ts` already proved flags a genuine anomaly: 21 days flat at $50/day, one real $500 spike on day 10. */
  const seedFlatSalesWithOneSpike = async (organizationId: string, storeId: string) => {
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    for (let i = 21; i >= 1; i--) {
      const subtotal = i === 10 ? '500.0000' : '50.0000';
      await salesRepo.recordIfNew({
        storeId,
        source: 'square',
        externalId: `SALES-ANOM-SWEEP-${organizationId}-${i}`,
        occurredAt: daysAgo(i),
        subtotal,
        discount: '0.0000',
        tax: '0.0000',
        total: subtotal,
        currency: 'USD',
        lines: [{ quantity: '1.000000', unitPrice: subtotal, discount: '0.0000', lineTotal: subtotal }],
      });
    }
  };

  it('a real, isolated single-day revenue spike produces a real notification', async () => {
    const { organizationId, storeId } = await setUpOrgStore();
    await seedFlatSalesWithOneSpike(organizationId, storeId);

    const processor = createSalesAnomalySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const result = await processor();

    expect(result.notified).toBeGreaterThanOrEqual(1);

    const notificationRepo = new NotificationRepository(db, organizationId);
    const spikeDate = daysAgo(10).toISOString().slice(0, 10);
    const dedupKey = buildSalesAnomalyDedupKey(storeId, spikeDate);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification).not.toBeNull();
    expect(notification?.entityType).toBe('store');
    expect(notification?.entityId).toBe(storeId);
    // A real dollar impact carrying the flagged day's own revenue figure through unchanged (I7).
    expect(notification?.dollarImpact).not.toBeNull();
    expect(Number(notification?.dollarImpact)).toBeCloseTo(500, 2);
  });

  it('fewer than 14 days of real sales history produces NO notification — an honest unknown, never a fabricated anomaly', async () => {
    const { organizationId, storeId } = await setUpOrgStore();
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    // Only 5 days of real sales — the metric's own real `unknown` threshold.
    for (let i = 5; i >= 1; i--) {
      await salesRepo.recordIfNew({
        storeId,
        source: 'square',
        externalId: `SALES-ANOM-SHORT-${organizationId}-${i}`,
        occurredAt: daysAgo(i),
        subtotal: '50.0000',
        discount: '0.0000',
        tax: '0.0000',
        total: '50.0000',
        currency: 'USD',
        lines: [{ quantity: '1.000000', unitPrice: '50.0000', discount: '0.0000', lineTotal: '50.0000' }],
      });
    }

    // `findActiveStoresForScheduling` sweeps every real active store in the whole database — a
    // shared dev DB can have other genuinely-anomalous stores from unrelated work, so
    // `result.notified` (the GLOBAL count across every store this tick) is not a safe assertion
    // here. `findUnresolvedForStore` is scoped to this exact test's own store, so this is the
    // real, scoped claim: no unresolved notification of any kind exists for THIS store.
    const processor = createSalesAnomalySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const notificationRepo = new NotificationRepository(db, organizationId);
    const unresolvedForThisStore = await notificationRepo.findUnresolvedForStore(storeId);
    expect(unresolvedForThisStore).toHaveLength(0);
  });

  it('a second sweep tick over the SAME still-flagged day updates the existing notification rather than creating a duplicate', async () => {
    const { organizationId, storeId } = await setUpOrgStore();
    await seedFlatSalesWithOneSpike(organizationId, storeId);

    const processor = createSalesAnomalySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const spikeDate = daysAgo(10).toISOString().slice(0, 10);
    const dedupKey = buildSalesAnomalyDedupKey(storeId, spikeDate);
    const notificationRepo = new NotificationRepository(db, organizationId);
    const first = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(first).not.toBeNull();

    await processor();

    const second = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(second?.id).toBe(first!.id);

    const allRows = await notificationRepo.findAllByDedupKey(dedupKey);
    expect(allRows).toHaveLength(1);
  });

  it('a day that falls OUT of the flagged set on a later sweep (e.g. the trailing window moves past it) RESOLVES the existing open notification', async () => {
    const { organizationId, storeId } = await setUpOrgStore();
    await seedFlatSalesWithOneSpike(organizationId, storeId);

    const processor = createSalesAnomalySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const spikeDate = daysAgo(10).toISOString().slice(0, 10);
    const dedupKey = buildSalesAnomalyDedupKey(storeId, spikeDate);
    const notificationRepo = new NotificationRepository(db, organizationId);
    const afterFirst = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterFirst).not.toBeNull();

    // Correct the spike day's own revenue back to the flat baseline — a real data correction, the
    // same class of "the underlying condition genuinely changed" scenario `lot-expiry-sweep-
    // processor.test.ts`'s own DEPLETED test proves for its rule type.
    await adminDb
      .update(salesTransactions)
      .set({ subtotal: '50.0000', total: '50.0000' })
      .where(eq(salesTransactions.organizationId, organizationId));

    await processor();

    const afterCorrection = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterCorrection).toBeNull();
  });

  it('one store genuinely throwing during evaluation does not prevent another real store in the same tick from being notified', async () => {
    const { organizationId: orgA, storeId: storeA } = await setUpOrgStore();
    const { organizationId: orgB, storeId: storeB } = await setUpOrgStore();
    await seedFlatSalesWithOneSpike(orgA, storeA);
    await seedFlatSalesWithOneSpike(orgB, storeB);

    // Force a genuine exception for orgA's own findOpenByDedupKey call, matching this codebase's
    // own established forced-throw isolation-testing technique (no real orphaned/malformed row can
    // be constructed without violating real FK/RLS integrity, so a spy on one method call is the
    // one available seam).
    const spy = vi.spyOn(NotificationRepository.prototype, 'findOpenByDedupKey').mockImplementationOnce(async () => {
      throw new Error('simulated transient failure for orgA');
    });

    try {
      const processor = createSalesAnomalySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
      const result = await processor();
      expect(result.notified).toBeGreaterThanOrEqual(1);

      const notificationRepoB = new NotificationRepository(db, orgB);
      const spikeDate = daysAgo(10).toISOString().slice(0, 10);
      const notificationB = await notificationRepoB.findOpenByDedupKey(buildSalesAnomalyDedupKey(storeB, spikeDate));
      expect(notificationB).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
