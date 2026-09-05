import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId, buildNegativeStockDedupKey } from '@retailos/domain';
import {
  createDb,
  withTenantContext,
  organizations,
  stores,
  products,
  productVariants,
  units,
  stockMovements,
  stockLevels,
  notifications,
  notificationRules,
  notificationDeliveries,
  notificationPreferences,
  memberships,
  users,
  StockLevelRepository,
  NotificationRepository,
  NotificationRuleRepository,
} from '@retailos/db';
import { createNegativeStockSweepProcessor } from './negative-stock-sweep-processor';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Proves `negative_stock`'s real trigger end to end against real Postgres: the sweep reads
 * `findNegativeStock`'s real cross-tenant `quantity < 0` rows and turns each one into a real
 * per-(store, product, variant) notification via the same dedup machinery `stock_below_reorder`
 * already proved. Not a re-test of `findNegativeStock`'s own detection SQL (covered in
 * `negative-stock.test.ts`) or of `evaluateNegativeStock` (covered as a pure function in
 * `packages/domain`) — what's unique here is the sweep's own composition: does a real negative row
 * resolve to one real database write, does a second sweep tick not double-notify, does a real
 * restock resolve the alert, and does one row's failure leave every other real row's outcome intact.
 */
describe('negative stock sweep processor', () => {
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
    await db.insert(organizations).values({ id: organizationId, name: 'Negative Stock Test Org', slug: `neg-stock-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Negative Stock Store', timezone: 'UTC' })
      )
    );
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `NEGSTOCK-${productId}`, name: 'Negative Stock Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );
    return { organizationId, storeId, productId, variantId };
  };

  it('a real negative stock_levels row produces a real notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'SALE_CONSUMPTION', quantity: '-5.000000', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    const processor = createNegativeStockSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const result = await processor();
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.notified).toBeGreaterThanOrEqual(1);

    const dedupKey = buildNegativeStockDedupKey(storeId, productId, variantId);
    const notificationRepo = new NotificationRepository(db, organizationId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);

    expect(notification).not.toBeNull();
    expect(notification?.entityId).toBe(productId);

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const provisionedRule = await ruleRepo.findById(notification!.ruleId);
    expect(provisionedRule?.ruleType).toBe('negative_stock');
  });

  it('a product with positive stock does NOT produce a notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'RECEIPT', quantity: '20.000000', unitCost: '1.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    const processor = createNegativeStockSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const dedupKey = buildNegativeStockDedupKey(storeId, productId, variantId);
    const notificationRepo = new NotificationRepository(db, organizationId);
    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).toBeNull();
  });

  it('a second sweep tick over the SAME still-negative row updates the existing notification rather than creating a duplicate', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'SALE_CONSUMPTION', quantity: '-8.000000', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    const processor = createNegativeStockSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const dedupKey = buildNegativeStockDedupKey(storeId, productId, variantId);
    const notificationRepo = new NotificationRepository(db, organizationId);
    const firstNotification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(firstNotification).not.toBeNull();

    await processor();

    const secondNotification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(secondNotification?.id).toBe(firstNotification!.id);

    const allRows = await notificationRepo.findAllByDedupKey(dedupKey);
    expect(allRows).toHaveLength(1);
  });

  it('a real receipt that brings quantity back to non-negative RESOLVES the existing open notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    const dedupKey = buildNegativeStockDedupKey(storeId, productId, variantId);
    const notificationRepo = new NotificationRepository(db, organizationId);
    const processor = createNegativeStockSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });

    // First: negative -> creates a real open notification.
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'SALE_CONSUMPTION', quantity: '-4.000000', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });
    await processor();
    const afterFirst = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterFirst).not.toBeNull();

    // Then: a real receipt brings quantity back to non-negative — the row disappears from
    // `findNegativeStock`'s own result set entirely (it's no longer `quantity < 0`), so this only
    // resolves via the sweep's separate "stale open notification" pass, not the per-row loop.
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'RECEIPT', quantity: '10.000000', unitCost: '1.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });
    const secondResult = await processor();
    expect(secondResult.resolved).toBeGreaterThanOrEqual(1);

    const afterReceipt = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterReceipt).toBeNull();

    const resolvedRow = await notificationRepo.findById(afterFirst!.id);
    expect(resolvedRow?.resolvedAt).not.toBeNull();
  });

  it('one row genuinely throwing during evaluation does not prevent another real negative row in the same sweep from being notified', async () => {
    const orgA = await setUpOrgStoreProduct();
    const orgB = await setUpOrgStoreProduct();

    const stockLevelRepoA = new StockLevelRepository(db, orgA.organizationId);
    await stockLevelRepoA.recordAndProject({
      id: generateId(), storeId: orgA.storeId, productId: orgA.productId, variantId: orgA.variantId, movementType: 'SALE_CONSUMPTION', quantity: '-3.000000', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });
    const stockLevelRepoB = new StockLevelRepository(db, orgB.organizationId);
    await stockLevelRepoB.recordAndProject({
      id: generateId(), storeId: orgB.storeId, productId: orgB.productId, variantId: orgB.variantId, movementType: 'SALE_CONSUMPTION', quantity: '-9.000000', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    // Forces a genuine exception for exactly orgB's row, on the real method the processor's
    // per-row evaluation calls first (`NotificationRepository.findOpenByDedupKey`) — every real
    // schema constraint in this database (FK, RLS) actively prevents constructing a naturally
    // orphaned/malformed row here, so this is the one real seam available to simulate "a bad row,
    // a transient DB error" (the sweep processor's own doc comment) without weakening any
    // constraint. Restored immediately after, so every other repository call in this test still
    // hits the real database.
    const orgBDedupKey = buildNegativeStockDedupKey(orgB.storeId, orgB.productId, orgB.variantId);
    const original = NotificationRepository.prototype.findOpenByDedupKey;
    const spy = vi.spyOn(NotificationRepository.prototype, 'findOpenByDedupKey').mockImplementation(async function (this: NotificationRepository, dedupKey: string) {
      if (dedupKey === orgBDedupKey) throw new Error('simulated transient failure for orgB');
      return original.call(this, dedupKey);
    });

    try {
      const processor = createNegativeStockSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
      const result = await processor();
      expect(result.total).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }

    const notificationRepoA = new NotificationRepository(db, orgA.organizationId);
    const notificationA = await notificationRepoA.findOpenByDedupKey(buildNegativeStockDedupKey(orgA.storeId, orgA.productId, orgA.variantId));
    expect(notificationA).not.toBeNull(); // orgA's real row still got its real notification despite orgB's row throwing

    const notificationRepoB = new NotificationRepository(db, orgB.organizationId);
    const notificationB = await notificationRepoB.findOpenByDedupKey(orgBDedupKey);
    expect(notificationB).toBeNull(); // orgB's row never got a notification — it genuinely threw, it wasn't silently skipped
  });
});
