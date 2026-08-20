import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { generateId, buildStockBelowReorderDedupKey } from '@retailos/domain';
import {
  createDb,
  withTenantContext,
  organizations,
  stores,
  products,
  productVariants,
  units,
  outboxEvents,
  stockMovements,
  stockLevels,
  stockParLevels,
  notifications,
  notificationRules,
  ParLevelRepository,
  StockLevelRepository,
  NotificationRepository,
  NotificationRuleRepository,
} from '@retailos/db';
import { createRuleEvaluationProcessor } from './rule-evaluation-processor';
import type { RelayJobData } from '@retailos/queue';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const asJob = (data: RelayJobData): Job<RelayJobData> => ({ data }) as Job<RelayJobData>;

/**
 * Proves the real first outbox consumer against real Postgres — the whole chain a relayed
 * `stock.moved` event triggers: real current quantity + real configured reorder point ->
 * `evaluateStockBelowReorder` -> `resolveDedupAction` -> a real `notifications` row (or its
 * resolution). Not a re-test of the pure functions themselves (already exhaustively covered in
 * `packages/domain`) — what's unique to this layer is the real repository composition: does a
 * `stock.moved` event's payload actually resolve to the right `StockLevelRepository`/
 * `ParLevelRepository` rows and produce a real database write.
 */
describe('rule evaluation processor: stock.moved -> stock_below_reorder', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(notifications).where(eq(notifications.organizationId, orgId));
      await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(stockParLevels).where(eq(stockParLevels.organizationId, orgId));
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
    await db.insert(organizations).values({ id: organizationId, name: 'Rule Eval Test Org', slug: `rule-eval-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Rule Eval Store', timezone: 'UTC' })
      )
    );
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `RULEEVAL-${productId}`, name: 'Rule Eval Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );
    return { organizationId, storeId, productId, variantId };
  };

  it('a real stock.moved event, with quantity below the configured reorder point, produces a real notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const parLevelRepo = new ParLevelRepository(db, organizationId);
    await parLevelRepo.setParLevel({ storeId, productId, variantId, reorderPoint: '10' });

    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '3', // below the reorder point of 10
      unitCost: '2.00',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'test',
    });

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING });
    const event: RelayJobData = {
      outboxEventId: generateId(),
      organizationId,
      aggregateType: 'stock_movement',
      aggregateId: generateId(),
      eventType: 'stock.moved',
      payload: { storeId, productId, variantId, movementType: 'RECEIPT', quantity: '3', movementId: generateId() },
    };

    await processor(asJob(event));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStockBelowReorderDedupKey(storeId, productId, variantId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);

    expect(notification).not.toBeNull();
    expect(notification?.severity).toBe('HIGH'); // the real catalogue default, no rule configured
    expect(notification?.entityId).toBe(productId);

    // A real notification_rules row was auto-provisioned (schema requires rule_id NOT NULL) — not
    // a synthetic/fabricated reference, a genuine row the notification centre can show.
    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const provisionedRule = await ruleRepo.findById(notification!.ruleId);
    expect(provisionedRule).not.toBeNull();
    expect(provisionedRule?.ruleType).toBe('stock_below_reorder');
    expect(provisionedRule?.storeId).toBeNull(); // org-wide default, not store-specific

    // A SECOND event for a DIFFERENT product in the same org reuses the SAME auto-provisioned
    // rule row, rather than creating a duplicate default rule on every fire.
    const secondProductId = generateId();
    const secondVariantId = generateId();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: secondProductId, organizationId, sku: `RULEEVAL2-${secondProductId}`, name: 'Second Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: secondVariantId, productId: secondProductId, name: 'Default', isDefault: true });
      })
    );
    const parLevelRepo2 = new ParLevelRepository(db, organizationId);
    await parLevelRepo2.setParLevel({ storeId, productId: secondProductId, variantId: secondVariantId, reorderPoint: '5' });
    const stockLevelRepo2 = new StockLevelRepository(db, organizationId);
    await stockLevelRepo2.recordAndProject({
      id: generateId(), storeId, productId: secondProductId, variantId: secondVariantId, movementType: 'RECEIPT', quantity: '1', unitCost: '1.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId: secondProductId, variantId: secondVariantId },
    }));
    const secondDedupKey = buildStockBelowReorderDedupKey(storeId, secondProductId, secondVariantId);
    const secondNotification = await notificationRepo.findOpenByDedupKey(secondDedupKey);
    expect(secondNotification?.ruleId).toBe(notification!.ruleId);
  });

  it('a real stock.moved event, with quantity ABOVE the reorder point, does NOT create a notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const parLevelRepo = new ParLevelRepository(db, organizationId);
    await parLevelRepo.setParLevel({ storeId, productId, variantId, reorderPoint: '10' });

    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(),
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '50', // well above the reorder point
      unitCost: '2.00',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'test',
    });

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING });
    const event: RelayJobData = {
      outboxEventId: generateId(),
      organizationId,
      aggregateType: 'stock_movement',
      aggregateId: generateId(),
      eventType: 'stock.moved',
      payload: { storeId, productId, variantId, movementType: 'RECEIPT', quantity: '50', movementId: generateId() },
    };

    await processor(asJob(event));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStockBelowReorderDedupKey(storeId, productId, variantId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification).toBeNull();
  });

  it('a restock that brings quantity back above the reorder point RESOLVES the existing open notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const parLevelRepo = new ParLevelRepository(db, organizationId);
    await parLevelRepo.setParLevel({ storeId, productId, variantId, reorderPoint: '10' });

    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING });
    const dedupKey = buildStockBelowReorderDedupKey(storeId, productId, variantId);
    const notificationRepo = new NotificationRepository(db, organizationId);

    // First: below reorder -> creates a real open notification.
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'RECEIPT', quantity: '3', unitCost: '2.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId, variantId },
    }));
    const afterFirst = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterFirst).not.toBeNull();

    // Then: a real restock brings quantity above the reorder point.
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'RECEIPT', quantity: '20', unitCost: '2.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId, variantId },
    }));

    const afterRestock = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterRestock).toBeNull();

    const resolvedRow = await notificationRepo.findById(afterFirst!.id);
    expect(resolvedRow?.resolvedAt).not.toBeNull();
  });

  it('an event type with no rule-evaluation mapping is a real no-op, not an error', async () => {
    const { organizationId } = await setUpOrgStoreProduct();
    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING });
    await expect(
      processor(asJob({
        outboxEventId: generateId(), organizationId, aggregateType: 'purchase_order', aggregateId: generateId(), eventType: 'po.created', payload: {},
      }))
    ).resolves.toBeUndefined();
  });

  it('no par level configured for the item at all is a real no-op — nothing to compare against, never treated as "unknown means fire"', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();
    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'RECEIPT', quantity: '1', unitCost: '2.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING });
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId, variantId },
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStockBelowReorderDedupKey(storeId, productId, variantId);
    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).toBeNull();
  });

  it('a tenant-configured rule severity overrides the catalogue default', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const parLevelRepo = new ParLevelRepository(db, organizationId);
    await parLevelRepo.setParLevel({ storeId, productId, variantId, reorderPoint: '10' });

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    await ruleRepo.create({
      ruleType: 'stock_below_reorder',
      severity: 'CRITICAL',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'RECEIPT', quantity: '2', unitCost: '2.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING });
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId, variantId },
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStockBelowReorderDedupKey(storeId, productId, variantId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification?.severity).toBe('CRITICAL');
  });
});
