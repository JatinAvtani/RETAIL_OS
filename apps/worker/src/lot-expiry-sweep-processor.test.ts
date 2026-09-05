import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId, buildExpiryDedupKey, resolveLocalDate } from '@retailos/domain';
import {
  createDb,
  withTenantContext,
  organizations,
  stores,
  products,
  productVariants,
  units,
  lots,
  stockMovements,
  stockLevels,
  notifications,
  notificationRules,
  notificationDeliveries,
  notificationPreferences,
  memberships,
  users,
  LotRepository,
  NotificationRepository,
  NotificationRuleRepository,
} from '@retailos/db';
import { createLotExpirySweepProcessor } from './lot-expiry-sweep-processor';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

const daysFromNow = (n: number): string => {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
};

/**
 * Proves `lot_expiring`'s real trigger end to end against real Postgres: the sweep reads
 * `findExpiryQueue`'s real cross-tenant at-risk rows, groups them by (org, store, store-local
 * date), and turns a firing group into a real `notifications` row via the same dedup/aggregation
 * machinery `stock_below_reorder` already proved in `rule-evaluation-processor.test.ts`. Not a
 * re-test of `findExpiryQueue`'s own detection SQL (covered in `expiry-queue.test.ts`) or of
 * `evaluateLotExpiring`/`aggregateNotificationContent` (covered as pure functions in
 * `packages/domain`) — what's unique to this layer is the sweep's own composition: does a real
 * at-risk lot actually resolve to one real database write, does a second sweep tick not
 * double-notify, and does one group's failure leave every other real group's outcome intact.
 */
describe('lot expiry sweep processor', () => {
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
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
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

  const setUpOrgStoreProduct = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Lot Expiry Test Org', slug: `lot-expiry-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Lot Expiry Store', timezone: 'UTC' })
      )
    );
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `LOTEXP-${productId}`, name: 'Lot Expiry Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );
    return { organizationId, storeId, productId, variantId };
  };

  it('a real at-risk lot (zero consumption history, real remaining quantity, real expiry date) produces a real notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      expiryDate: daysFromNow(2), // within the default 3-day withinDays window
      initialQuantity: '50.000000',
      unitCost: '4.0000',
      currency: 'USD',
    });

    const processor = createLotExpirySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const result = await processor();
    expect(result.groups).toBeGreaterThanOrEqual(1);
    expect(result.notified).toBeGreaterThanOrEqual(1);

    const localDate = resolveLocalDate(new Date(), 'UTC');
    const dedupKey = buildExpiryDedupKey(storeId, localDate);
    const notificationRepo = new NotificationRepository(db, organizationId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);

    expect(notification).not.toBeNull();
    expect(notification?.dollarImpact).not.toBeNull(); // real valueAtRisk (quantity x unitCost), never synthesized
    expect(Number(notification?.dollarImpact)).toBeCloseTo(200, 2); // 50 * 4.00
    // The notification center's own "linked source entity" gap (2026-09 fix): this sweep used to
    // write no entityType/entityId at all, leaving every lot_expiring notification with no real
    // link back to what it's about.
    expect(notification?.entityType).toBe('store');
    expect(notification?.entityId).toBe(storeId);

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const provisionedRule = await ruleRepo.findById(notification!.ruleId);
    expect(provisionedRule?.ruleType).toBe('lot_expiring');
  });

  it('a lot expiring well outside the configured window does NOT produce a notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      expiryDate: daysFromNow(365), // far outside any at-risk window
      initialQuantity: '50.000000',
      unitCost: '4.0000',
      currency: 'USD',
    });

    const processor = createLotExpirySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const localDate = resolveLocalDate(new Date(), 'UTC');
    const dedupKey = buildExpiryDedupKey(storeId, localDate);
    const notificationRepo = new NotificationRepository(db, organizationId);
    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).toBeNull();
  });

  it('a second sweep tick over the SAME still-at-risk lot updates the existing notification rather than creating a duplicate', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      expiryDate: daysFromNow(1),
      initialQuantity: '10.000000',
      unitCost: '3.0000',
      currency: 'USD',
    });

    const processor = createLotExpirySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const localDate = resolveLocalDate(new Date(), 'UTC');
    const dedupKey = buildExpiryDedupKey(storeId, localDate);
    const notificationRepo = new NotificationRepository(db, organizationId);
    const firstNotification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(firstNotification).not.toBeNull();

    await processor();

    const secondNotification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(secondNotification?.id).toBe(firstNotification!.id); // same row, UPDATEd not duplicated

    const allRows = await notificationRepo.findAllByDedupKey(dedupKey);
    expect(allRows).toHaveLength(1);
  });

  it('a lot that is fully consumed (DEPLETED) since the last tick RESOLVES the existing open notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const lotRepo = new LotRepository(db, organizationId);
    const lot = await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      expiryDate: daysFromNow(1),
      initialQuantity: '12.000000',
      unitCost: '2.5000',
      currency: 'USD',
    });

    const processor = createLotExpirySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const localDate = resolveLocalDate(new Date(), 'UTC');
    const dedupKey = buildExpiryDedupKey(storeId, localDate);
    const notificationRepo = new NotificationRepository(db, organizationId);
    const afterFirst = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterFirst).not.toBeNull();

    // The lot is fully consumed since the last tick — a real DEPLETED transition, exactly the
    // state `findExpiryQueue`'s own `WHERE status = 'ACTIVE'` filter excludes. The lot (and
    // therefore its whole (store, local-date) group, since it's the only lot in it) disappears
    // from `findExpiryQueue`'s result set entirely, so this only resolves via the sweep's separate
    // "stale open notification" pass, not the per-group loop.
    await adminDb.update(lots).set({ status: 'DEPLETED', remainingQuantity: '0.000000' }).where(eq(lots.id, lot.id));

    const secondResult = await processor();
    expect(secondResult.resolved).toBeGreaterThanOrEqual(1);

    const afterDepletion = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterDepletion).toBeNull();

    const resolvedRow = await notificationRepo.findById(afterFirst!.id);
    expect(resolvedRow?.resolvedAt).not.toBeNull();
  });

  it('a rule row with a malformed threshold falls back to the catalogue default rather than breaking evaluation', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    // `resolveLotExpiringThreshold`'s own documented contract: never throws on a malformed
    // `withinDays`, always falls back to `DEFAULT_LOT_EXPIRING_THRESHOLD` — a tenant's bad config
    // data must not break that tenant's own sweep, let alone any other tenant's.
    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    await ruleRepo.create({
      ruleType: 'lot_expiring',
      severity: 'HIGH',
      threshold: { withinDays: 'not-a-number' } as unknown as Record<string, unknown>,
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      expiryDate: daysFromNow(1), // within the real DEFAULT_LOT_EXPIRING_THRESHOLD (3 days) fallback
      initialQuantity: '15.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });

    const processor = createLotExpirySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const localDate = resolveLocalDate(new Date(), 'UTC');
    const notificationRepo = new NotificationRepository(db, organizationId);
    const notification = await notificationRepo.findOpenByDedupKey(buildExpiryDedupKey(storeId, localDate));
    expect(notification).not.toBeNull();
  });

  it('one organization genuinely throwing during group evaluation does not prevent another real organization group in the same tick from being notified', async () => {
    const orgA = await setUpOrgStoreProduct();
    const orgB = await setUpOrgStoreProduct();

    const lotRepoA = new LotRepository(db, orgA.organizationId);
    await lotRepoA.receive({
      id: generateId(),
      storeId: orgA.storeId,
      productId: orgA.productId,
      variantId: orgA.variantId,
      receivedAt: new Date(),
      expiryDate: daysFromNow(1),
      initialQuantity: '20.000000',
      unitCost: '5.0000',
      currency: 'USD',
    });
    const lotRepoB = new LotRepository(db, orgB.organizationId);
    await lotRepoB.receive({
      id: generateId(),
      storeId: orgB.storeId,
      productId: orgB.productId,
      variantId: orgB.variantId,
      receivedAt: new Date(),
      expiryDate: daysFromNow(1),
      initialQuantity: '15.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });

    const localDate = resolveLocalDate(new Date(), 'UTC');
    const orgBDedupKey = buildExpiryDedupKey(orgB.storeId, localDate);

    // Forces a genuine exception for exactly orgB's (store, local-date) group, on the real method
    // the processor's per-group evaluation calls first (`NotificationRepository.findOpenByDedupKey`)
    // — every real schema constraint in this database (FK, RLS) actively prevents constructing a
    // naturally malformed group here, so this is the one real seam available to simulate "a bad
    // row, a transient DB error" (this processor's own doc comment) without weakening any
    // constraint. Restored immediately after, so every other repository call in this test still
    // hits the real database.
    const original = NotificationRepository.prototype.findOpenByDedupKey;
    const spy = vi.spyOn(NotificationRepository.prototype, 'findOpenByDedupKey').mockImplementation(async function (this: NotificationRepository, dedupKey: string) {
      if (dedupKey === orgBDedupKey) throw new Error('simulated transient failure for orgB');
      return original.call(this, dedupKey);
    });

    try {
      const processor = createLotExpirySweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
      const result = await processor();
      expect(result.groups).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }

    const notificationRepoA = new NotificationRepository(db, orgA.organizationId);
    const notificationA = await notificationRepoA.findOpenByDedupKey(buildExpiryDedupKey(orgA.storeId, localDate));
    expect(notificationA).not.toBeNull(); // orgA's real group still got its real notification despite orgB's group throwing

    const notificationRepoB = new NotificationRepository(db, orgB.organizationId);
    const notificationB = await notificationRepoB.findOpenByDedupKey(orgBDedupKey);
    expect(notificationB).toBeNull(); // orgB's group never got a notification — it genuinely threw, it wasn't silently skipped
  });
});
