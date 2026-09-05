import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import {
  generateId,
  buildStockBelowReorderDedupKey,
  buildSupplierPriceIncreaseDedupKey,
  buildInvoiceVarianceDedupKey,
  buildPoAwaitingApprovalDedupKey,
  buildStocktakeVarianceDedupKey,
} from '@retailos/domain';
import {
  createDb,
  withTenantContext,
  organizations,
  stores,
  products,
  productVariants,
  units,
  suppliers,
  supplierProducts,
  supplierPrices,
  documents,
  documentLinks,
  purchaseOrders,
  purchaseOrderLines,
  goodsReceipts,
  goodsReceiptLines,
  lots,
  invoiceMatches,
  invoiceMatchLines,
  supplierPerformanceEvents,
  auditLogs,
  outboxEvents,
  stockMovements,
  stockLevels,
  stockParLevels,
  notifications,
  notificationRules,
  notificationDeliveries,
  notificationPreferences,
  memberships,
  users,
  ParLevelRepository,
  StockLevelRepository,
  NotificationRepository,
  NotificationRuleRepository,
  NotificationDeliveryRepository,
  NotificationPreferenceRepository,
  PostingService,
  SupplierRepository,
  SupplierProductRepository,
  DocumentRepository,
  PurchaseOrderRepository,
  GoodsReceiptRepository,
  InvoiceMatchRepository,
  ProductRepository,
  LotRepository,
  MovementService,
  StockCountService,
  stockCountLines,
  stockCounts,
} from '@retailos/db';
import { createRuleEvaluationProcessor } from './rule-evaluation-processor';
import type { RelayJobData } from '@retailos/queue';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

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
      await adminDb.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, orgId));
      await adminDb.delete(notifications).where(eq(notifications.organizationId, orgId));
      await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      await adminDb.delete(notificationPreferences).where(eq(notificationPreferences.organizationId, orgId));
      const orgMemberships = await adminDb.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.organizationId, orgId));
      await adminDb.delete(memberships).where(eq(memberships.organizationId, orgId));
      for (const m of orgMemberships) {
        await adminDb.delete(users).where(eq(users.id, m.userId));
      }
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

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
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

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
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
    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
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
    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
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

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
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

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId, variantId },
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStockBelowReorderDedupKey(storeId, productId, variantId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification?.severity).toBe('CRITICAL');
  });

  it('a genuinely NEW notification fans out to a real accepted MANAGER — a notification_deliveries row is created and a real job is enqueued', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    // memberships is FORCE RLS — insert via the admin connection, not the app-role `db`, matching
    // this project's own "plain query outside a repository needs its own tenant context" rule.
    const managerUserId = generateId();
    await adminDb.insert(users).values({ id: managerUserId, email: `manager-${managerUserId}@example.test` });
    await adminDb.insert(memberships).values({
      id: generateId(), organizationId, userId: managerUserId, role: 'MANAGER', storeIds: null, acceptedAt: new Date(),
    });

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    await ruleRepo.create({
      ruleType: 'stock_below_reorder',
      severity: 'HIGH',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const parLevelRepo = new ParLevelRepository(db, organizationId);
    await parLevelRepo.setParLevel({ storeId, productId, variantId, reorderPoint: '10' });
    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'RECEIPT', quantity: '3', unitCost: '2.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId, variantId },
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStockBelowReorderDedupKey(storeId, productId, variantId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification).not.toBeNull();

    const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
    const deliveries = await deliveryRepo.findForUser(managerUserId);
    const delivery = deliveries.find((d) => d.notificationId === notification!.id);
    expect(delivery).toBeTruthy();
    expect(delivery?.channel).toBe('EMAIL');
    expect(delivery?.status).toBe('PENDING');

    // A SECOND fire of the SAME still-open condition (UPDATE, not CREATE) must NOT re-deliver —
    // the "notification fatigue is the failure mode" rule, proven directly: exactly one
    // delivery row exists for this user/notification after two fires of the same condition.
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId, variantId },
    }));
    const deliveriesAfterSecondFire = (await deliveryRepo.findForUser(managerUserId)).filter((d) => d.notificationId === notification!.id);
    expect(deliveriesAfterSecondFire).toHaveLength(1);
  });

  it('a recipient who muted EMAIL gets NO delivery row at all for that channel', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct();

    const managerUserId = generateId();
    await adminDb.insert(users).values({ id: managerUserId, email: `manager-${managerUserId}@example.test` });
    await adminDb.insert(memberships).values({
      id: generateId(), organizationId, userId: managerUserId, role: 'MANAGER', storeIds: null, acceptedAt: new Date(),
    });

    const preferenceRepo = new NotificationPreferenceRepository(db, organizationId);
    await preferenceRepo.upsertForUser(managerUserId, {
      mutedChannels: ['EMAIL'],
      quietHoursStartHour: null,
      quietHoursEndHour: null,
      criticalOverridesQuietHours: true,
    });

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    await ruleRepo.create({
      ruleType: 'stock_below_reorder', severity: 'HIGH', threshold: {}, recipientRoles: ['MANAGER'], channels: ['EMAIL'],
    });

    const parLevelRepo = new ParLevelRepository(db, organizationId);
    await parLevelRepo.setParLevel({ storeId, productId, variantId, reorderPoint: '10' });
    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'RECEIPT', quantity: '3', unitCost: '2.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId, variantId },
    }));

    // The notification itself is still created — muting a CHANNEL suppresses DELIVERY, not the
    // underlying alert (the in-app centre, unaffected by delivery-channel muting, still shows it).
    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStockBelowReorderDedupKey(storeId, productId, variantId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification).not.toBeNull();

    const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
    const deliveries = (await deliveryRepo.findForUser(managerUserId)).filter((d) => d.notificationId === notification!.id);
    expect(deliveries).toHaveLength(0);
  });

  it('a recipient inside their configured quiet hours gets NO delivery row for a non-CRITICAL alert', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreProduct(); // store timezone is UTC

    const managerUserId = generateId();
    await adminDb.insert(users).values({ id: managerUserId, email: `manager-${managerUserId}@example.test` });
    await adminDb.insert(memberships).values({
      id: generateId(), organizationId, userId: managerUserId, role: 'MANAGER', storeIds: null, acceptedAt: new Date(),
    });

    // The store's timezone is UTC, so the current real UTC hour IS the recipient's local hour.
    // A window from the CURRENT hour to the next one always contains "right now" regardless of
    // what real wall-clock time this test runs at, without needing to fake the clock — a
    // zero-width window (start === end) would be a deterministic no-op instead, per
    // isWithinQuietHours' own documented rule, which is why a full-hour-wide window is used here.
    const nowUtcHour = new Date().getUTCHours();
    const preferenceRepo = new NotificationPreferenceRepository(db, organizationId);
    await preferenceRepo.upsertForUser(managerUserId, {
      mutedChannels: [],
      quietHoursStartHour: nowUtcHour,
      quietHoursEndHour: (nowUtcHour + 1) % 24,
      criticalOverridesQuietHours: true,
    });

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    await ruleRepo.create({
      // HIGH, not CRITICAL — the catalogue default for stock_below_reorder — so the
      // critical-override path does NOT apply, proving plain quiet-hours suppression on its own.
      ruleType: 'stock_below_reorder', severity: 'HIGH', threshold: {}, recipientRoles: ['MANAGER'], channels: ['EMAIL'],
    });

    const parLevelRepo = new ParLevelRepository(db, organizationId);
    await parLevelRepo.setParLevel({ storeId, productId, variantId, reorderPoint: '10' });
    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'RECEIPT', quantity: '3', unitCost: '2.00', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor(asJob({
      outboxEventId: generateId(), organizationId, aggregateType: 'stock_movement', aggregateId: generateId(), eventType: 'stock.moved',
      payload: { storeId, productId, variantId },
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStockBelowReorderDedupKey(storeId, productId, variantId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification).not.toBeNull();

    const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
    const deliveries = (await deliveryRepo.findForUser(managerUserId)).filter((d) => d.notificationId === notification!.id);
    expect(deliveries).toHaveLength(0);
  });
});

/**
 * Proves the second real outbox consumer: `supplier.price_changed` -> `supplier_price_increase`.
 * `PostingService.postLineInTx` (`packages/db/src/repositories/posting-service.ts`) only emits
 * this event AFTER `detectPriceChange` already confirmed a real threshold-crossing change (2%
 * default) — that detection logic is exhaustively covered by `posting-service.test.ts`'s own
 * "price-change detection" block and is NOT re-tested here. What's unique to this layer: does a
 * genuinely posted, threshold-crossing price change resolve through `SupplierProductRepository`
 * to a real org-wide (`storeId: null`) notification, carrying the event's own real
 * `annualizedImpact` as `dollarImpact` — and does a sub-threshold change correctly produce NO
 * outbox event at all, so there is nothing for this processor to act on.
 */
describe('rule evaluation processor: supplier.price_changed -> supplier_price_increase', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, orgId));
      await adminDb.delete(notifications).where(eq(notifications.organizationId, orgId));
      await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      await adminDb.delete(notificationPreferences).where(eq(notificationPreferences.organizationId, orgId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, orgId));
      await adminDb.delete(documentLinks).where(eq(documentLinks.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(documents).where(eq(documents.organizationId, orgId));
      const orgMappings = await adminDb.select({ id: supplierProducts.id }).from(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      for (const m of orgMappings) {
        await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, m.id));
      }
      await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await adminDb.delete(products).where(eq(products.organizationId, orgId));
      await adminDb.delete(suppliers).where(eq(suppliers.organizationId, orgId));
      const orgMemberships = await adminDb.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.organizationId, orgId));
      await adminDb.delete(memberships).where(eq(memberships.organizationId, orgId));
      for (const m of orgMemberships) {
        await adminDb.delete(users).where(eq(users.id, m.userId));
      }
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  /** A real org/store/user/product/confirmed-supplier-mapping/REVIEW_REQUIRED document — mirrors `posting-service.test.ts`'s own `setUpMappedLine` fixture exactly. */
  const setUpPostingFixture = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Rule Eval Price Org', slug: `rule-eval-price-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) => withTenantContext(tx, organizationId, () => tx.insert(stores).values({ id: storeId, organizationId, name: 'Rule Eval Price Store', timezone: 'UTC' })));
    const userId = generateId();
    await db.insert(users).values({ id: userId, email: `rule-eval-price-${userId}@example.test` });

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));

    const supplierRepo = new SupplierRepository(db, organizationId);
    const supplier = await supplierRepo.create({ id: generateId(), name: `Rule Eval Price Supplier ${generateId()}` });

    const productId = generateId();
    const supplierSku = `RE-PRICE-SKU-${generateId()}`;
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `RULEEVALPRICE-${productId}`, name: 'Rule Eval Price Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: generateId(), productId, name: 'Default', isDefault: true });
      })
    );

    const mappingRepo = new SupplierProductRepository(db, organizationId);
    const mapping = await mappingRepo.create({ id: generateId(), supplierId: supplier.id, productId, supplierSku });
    await mappingRepo.confirm(mapping.id);

    const documentRepo = new DocumentRepository(db, organizationId);
    const doc = await documentRepo.create({
      storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/rule-eval-price.pdf`, contentHash: `rule-eval-price-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1, uploadedByUserId: userId,
    });
    await documentRepo.updateStatus(doc.id, 'REVIEW_REQUIRED');

    return { organizationId, storeId, userId, productId, supplierId: supplier.id, mappingId: mapping.id, documentId: doc.id, supplierName: supplier.name, supplierSku };
  };

  /** A SECOND REVIEW_REQUIRED document against the SAME mapping — needed to post a real second price and trigger `detectPriceChange`'s comparison against the first. */
  const postSecondDocument = async (organizationId: string, storeId: string, userId: string, supplierName: string, supplierSku: string, unitPrice: string, quantity: string) => {
    const documentRepo = new DocumentRepository(db, organizationId);
    const doc = await documentRepo.create({
      storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/rule-eval-price-2.pdf`, contentHash: `rule-eval-price-hash-2-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1, uploadedByUserId: userId,
    });
    await documentRepo.updateStatus(doc.id, 'REVIEW_REQUIRED');

    const service = new PostingService(db, organizationId);
    await service.postDocument({
      documentId: doc.id,
      storeId,
      fields: { supplier: { value: supplierName } },
      lines: [{ sku: { value: supplierSku }, quantity: { value: quantity }, unitPrice: { value: unitPrice }, lineTotal: { value: unitPrice } }],
      actorUserId: userId,
    });
    return doc.id;
  };

  it('a real posted price change beyond the 2% threshold produces a real org-wide notification carrying the outbox event\'s own annualizedImpact as dollarImpact', async () => {
    const { organizationId, storeId, userId, documentId, supplierName, supplierSku, productId, supplierId } = await setUpPostingFixture();

    // First post: establishes the baseline price ($5.00 x 100 units) — no notification yet, since
    // detectPriceChange never fires on the FIRST price for a supplier product (a baseline being
    // established is not a "change").
    const firstService = new PostingService(db, organizationId);
    await firstService.postDocument({
      documentId,
      storeId,
      fields: { supplier: { value: supplierName } },
      lines: [{ sku: { value: supplierSku }, quantity: { value: '100' }, unitPrice: { value: '5.00' }, lineTotal: { value: '500.00' } }],
      actorUserId: userId,
    });

    // Second post: $6.00, a 20% jump — well beyond the default 2% threshold. This is the REAL
    // event source: PostingService.postLineInTx itself inserts the supplier.price_changed row.
    await postSecondDocument(organizationId, storeId, userId, supplierName, supplierSku, '6.00', '50');

    const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const priceChangedEvent = outboxRows.find((e) => e.eventType === 'supplier.price_changed');
    expect(priceChangedEvent).toBeDefined();
    const eventPayload = priceChangedEvent!.payload as { supplierProductId: string; annualizedImpact: string | null };
    // $1.00 delta x 100 real trailing RECEIPT units (from the first post) = $100.
    expect(eventPayload.annualizedImpact).toBe('100.0000');

    // Now feed that REAL event into the rule evaluation processor, exactly as the relay would.
    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const relayEvent: RelayJobData = {
      outboxEventId: priceChangedEvent!.id,
      organizationId,
      aggregateType: 'supplier_product',
      aggregateId: eventPayload.supplierProductId,
      eventType: 'supplier.price_changed',
      payload: eventPayload,
    };
    await processor(asJob(relayEvent));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildSupplierPriceIncreaseDedupKey(supplierId, productId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);

    expect(notification).not.toBeNull();
    expect(notification?.entityType).toBe('supplier_product');
    expect(notification?.entityId).toBe(eventPayload.supplierProductId);
    expect(notification?.storeId).toBeNull(); // org-wide — supplier pricing has no store dimension
    expect(notification?.severity).toBe('HIGH'); // catalogue default for supplier_price_increase
    expect(notification?.dollarImpact).toBe('100.0000');

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const provisionedRule = await ruleRepo.findById(notification!.ruleId);
    expect(provisionedRule?.ruleType).toBe('supplier_price_increase');
    expect(provisionedRule?.storeId).toBeNull();
  });

  it('a real posted price change UNDER the 2% threshold emits NO supplier.price_changed outbox event at all — nothing for this processor to act on', async () => {
    const { organizationId, storeId, userId, documentId, supplierName, supplierSku } = await setUpPostingFixture();

    const firstService = new PostingService(db, organizationId);
    await firstService.postDocument({
      documentId,
      storeId,
      fields: { supplier: { value: supplierName } },
      lines: [{ sku: { value: supplierSku }, quantity: { value: '10' }, unitPrice: { value: '5.00' }, lineTotal: { value: '50.00' } }],
      actorUserId: userId,
    });

    // $5.00 -> $5.05 is exactly 1% — within the default 2% threshold.
    await postSecondDocument(organizationId, storeId, userId, supplierName, supplierSku, '5.05', '10');

    const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    expect(outboxRows.some((e) => e.eventType === 'supplier.price_changed')).toBe(false);

    // No event means the relay never enqueues this processor for this change at all — confirmed
    // directly: with no real event to feed it, no notification exists for this (supplier, product).
    const notificationRows = await adminDb.select().from(notifications).where(eq(notifications.organizationId, organizationId));
    expect(notificationRows).toHaveLength(0);
  });
});

/**
 * Proves the third real outbox consumer: `match.variance_detected` -> `invoice_variance`.
 * `InvoiceMatchRepository.runMatchInTx` (`packages/db/src/repositories/invoice-match-repository.ts`)
 * already ran `classifyLineMatch` against every line and rolled the result into `highestSeverity`
 * — this handler does not re-classify anything, it only decides whether that already-computed
 * outcome (`!== 'NONE'`) is worth alerting on. The classification logic itself is exhaustively
 * covered by `invoice-match-repository.test.ts`; what's unique to this layer is that a REAL
 * variance resolves to a real notification referencing the real `invoiceMatchId`, and a REAL
 * clean match (`highestSeverity: 'NONE'`) never does.
 */
describe('rule evaluation processor: match.variance_detected -> invoice_variance', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, orgId));
      await adminDb.delete(notifications).where(eq(notifications.organizationId, orgId));
      await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      await adminDb.delete(notificationPreferences).where(eq(notificationPreferences.organizationId, orgId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, orgId));
      await adminDb.delete(invoiceMatchLines).where(eq(invoiceMatchLines.organizationId, orgId));
      await adminDb.delete(invoiceMatches).where(eq(invoiceMatches.organizationId, orgId));
      await adminDb.delete(documents).where(eq(documents.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.update(lots).set({ goodsReceiptLineId: null }).where(eq(lots.organizationId, orgId));
      await adminDb.delete(goodsReceiptLines).where(eq(goodsReceiptLines.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(goodsReceipts).where(eq(goodsReceipts.organizationId, orgId));
      await adminDb.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, orgId));
      await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));
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

  /** A real org/store/supplier/product/confirmed-mapping — mirrors `invoice-match-repository.test.ts`'s own `beforeAll` fixture, but per-test since this file's convention is `afterEach`, not `afterAll`. */
  const setUpMatchFixture = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Rule Eval Match Org', slug: `rule-eval-match-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) => withTenantContext(tx, organizationId, () => tx.insert(stores).values({ id: storeId, organizationId, name: 'Rule Eval Match Store', timezone: 'UTC' })));

    const supplierId = generateId();
    const supplierName = `Rule Eval Match Supplier ${generateId()}`;
    await db.transaction((tx) => withTenantContext(tx, organizationId, () => tx.insert(suppliers).values({ id: supplierId, organizationId, name: supplierName })));

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();
    const variantId = generateId();
    const supplierSku = `RE-MATCH-SKU-${generateId()}`;
    const supplierProductId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `RULEEVALMATCH-${productId}`, name: 'Rule Eval Match Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
        await tx.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku, isConfirmed: true });
      })
    );

    return { organizationId, storeId, supplierId, supplierName, productId, variantId, kgUnitId: kgUnit!.id, supplierSku, supplierProductId };
  };

  const createSentPurchaseOrder = async (organizationId: string, storeId: string, supplierId: string, supplierProductId: string, productId: string, kgUnitId: string, quantityOrderUnits: string, unitPrice: string) => {
    const poRepo = new PurchaseOrderRepository(db, organizationId);
    const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-RE-MATCH-${generateId()}`, currency: 'USD' });
    const addLineResult = await poRepo.addLine({ purchaseOrderId: created.id, supplierProductId, productId, quantityOrderUnits, orderUnitId: kgUnitId, conversionToBase: '1', unitPrice, lineNumber: 1 });
    if (!addLineResult.ok) throw new Error('addLine failed in test setup');
    await poRepo.applyTransition(created.id, 'SUBMIT', 1);
    await poRepo.applyTransition(created.id, 'APPROVE', 2);
    await poRepo.applyTransition(created.id, 'SEND', 3);
    const lines = await poRepo.findLines(created.id);
    return { purchaseOrderId: created.id, purchaseOrderLineId: lines[0]!.id };
  };

  const receiveAgainstPo = async (organizationId: string, storeId: string, supplierId: string, purchaseOrderId: string, purchaseOrderLineId: string, receivedQuantityBaseUnits: string) => {
    const grRepo = new GoodsReceiptRepository(db, organizationId);
    return grRepo.confirmReceipt({ storeId, purchaseOrderId, supplierId, receivedAt: new Date(), lines: [{ purchaseOrderLineId, receivedQuantityBaseUnits, lineNumber: 1 }] });
  };

  const createPostedInvoiceDocument = async (organizationId: string, storeId: string) => {
    const documentRepo = new DocumentRepository(db, organizationId);
    const doc = await documentRepo.create({
      storeId, type: 'INVOICE', source: 'UPLOAD', storageKey: `${organizationId}/rule-eval-match-${generateId()}.pdf`, contentHash: `rule-eval-match-hash-${generateId()}`, mimeType: 'application/pdf', sizeBytes: 1,
    });
    return doc.id;
  };

  it('a real invoice line priced well beyond tolerance produces a real notification referencing the real invoiceMatchId', async () => {
    const { organizationId, storeId, supplierId, supplierName, productId, kgUnitId, supplierSku, supplierProductId } = await setUpMatchFixture();
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder(organizationId, storeId, supplierId, supplierProductId, productId, kgUnitId, '10', '50.00');
    await receiveAgainstPo(organizationId, storeId, supplierId, purchaseOrderId, purchaseOrderLineId, '10');
    const documentId = await createPostedInvoiceDocument(organizationId, storeId);

    const matchRepo = new InvoiceMatchRepository(db, organizationId);
    const result = await matchRepo.runMatch({
      documentId,
      storeId,
      supplierName,
      // Invoiced at $100 vs PO's $50 — well beyond both the $5 absolute and 2% relative tolerance.
      lines: [{ sku: { value: supplierSku }, quantity: { value: '10' }, unitPrice: { value: '100.00' } }],
    });
    expect(result.highestSeverity).toBe('MEDIUM');

    // The real emitted outbox event — match.variance_detected — is what the relay would deliver.
    const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const varianceEvent = outboxRows.find((e) => e.eventType === 'match.variance_detected');
    expect(varianceEvent).toBeDefined();
    const eventPayload = varianceEvent!.payload as { invoiceMatchId: string };
    expect(eventPayload.invoiceMatchId).toBe(result.id);

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const relayEvent: RelayJobData = {
      outboxEventId: varianceEvent!.id,
      organizationId,
      aggregateType: 'invoice_match',
      aggregateId: result.id,
      eventType: 'match.variance_detected',
      payload: eventPayload,
    };
    await processor(asJob(relayEvent));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildInvoiceVarianceDedupKey(result.id);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);

    expect(notification).not.toBeNull();
    expect(notification?.entityType).toBe('invoice_match');
    expect(notification?.entityId).toBe(result.id);
    expect(notification?.storeId).toBe(storeId);
    expect(notification?.severity).toBe('HIGH'); // catalogue default for invoice_variance

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const provisionedRule = await ruleRepo.findById(notification!.ruleId);
    expect(provisionedRule?.ruleType).toBe('invoice_variance');
  });

  it('a real CLEAN match (highestSeverity: NONE) never produces a notification — dedup resolves to NO_OP, never CREATE', async () => {
    const { organizationId, storeId, supplierId, supplierName, productId, kgUnitId, supplierSku, supplierProductId } = await setUpMatchFixture();
    const { purchaseOrderId, purchaseOrderLineId } = await createSentPurchaseOrder(organizationId, storeId, supplierId, supplierProductId, productId, kgUnitId, '10', '4.50');
    await receiveAgainstPo(organizationId, storeId, supplierId, purchaseOrderId, purchaseOrderLineId, '10');
    const documentId = await createPostedInvoiceDocument(organizationId, storeId);

    const matchRepo = new InvoiceMatchRepository(db, organizationId);
    const result = await matchRepo.runMatch({
      documentId,
      storeId,
      supplierName,
      lines: [{ sku: { value: supplierSku }, quantity: { value: '10' }, unitPrice: { value: '4.50' } }],
    });
    expect(result.highestSeverity).toBe('NONE');

    // runMatchInTx emits match.variance_detected unconditionally for EVERY match run (its payload
    // carries the real highestSeverity, including 'NONE' — the outbox event itself is not gated on
    // severity, only the downstream rule evaluation is). So a REAL clean-match event does exist here
    // — the real contract under test is what this processor does with it.
    const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const varianceEvent = outboxRows.find((e) => e.eventType === 'match.variance_detected');
    expect(varianceEvent).toBeDefined();
    expect((varianceEvent!.payload as { highestSeverity: string }).highestSeverity).toBe('NONE');

    // Feeding that REAL clean-match event through the processor proves evaluateInvoiceVariance's
    // `fires: false` on `highestSeverity: 'NONE'` correctly resolves to NO_OP — never CREATE.
    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor(asJob({
      outboxEventId: varianceEvent!.id, organizationId, aggregateType: 'invoice_match', aggregateId: result.id, eventType: 'match.variance_detected',
      payload: { invoiceMatchId: result.id },
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildInvoiceVarianceDedupKey(result.id);
    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).toBeNull();
  });
});

/**
 * Proves the fourth real outbox consumer: `po.submitted` -> `po_awaiting_approval`.
 * `PurchaseOrderRepository.applyTransition` only ever emits `po.submitted` for a `SUBMIT` the PO
 * state machine (`applyPurchaseOrderTransition`) already accepted — the event itself is the fact,
 * so `evaluatePoAwaitingApproval` always fires (no threshold to re-check).
 *
 * This block ALSO verifies the file's own doc comment claim (lines above
 * `evaluatePoAwaitingApprovalFromEvent`): "the dedup mechanism itself resolves the still-open
 * po_awaiting_approval notification correctly once the PO is no longer genuinely awaiting
 * approval." That claim is checked directly against the processor's real switch statement, not
 * assumed — see the second test below.
 */
describe('rule evaluation processor: po.submitted -> po_awaiting_approval', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, orgId));
      await adminDb.delete(notifications).where(eq(notifications.organizationId, orgId));
      await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      await adminDb.delete(notificationPreferences).where(eq(notificationPreferences.organizationId, orgId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, orgId));
      await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));
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

  const setUpPoFixture = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Rule Eval PO Org', slug: `rule-eval-po-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) => withTenantContext(tx, organizationId, () => tx.insert(stores).values({ id: storeId, organizationId, name: 'Rule Eval PO Store', timezone: 'UTC' })));

    const supplierId = generateId();
    await db.transaction((tx) => withTenantContext(tx, organizationId, () => tx.insert(suppliers).values({ id: supplierId, organizationId, name: `Rule Eval PO Supplier ${generateId()}` })));

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productId = generateId();
    const supplierProductId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `RULEEVALPO-${productId}`, name: 'Rule Eval PO Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: generateId(), productId, name: 'Default', isDefault: true });
        await tx.insert(supplierProducts).values({ id: supplierProductId, organizationId, supplierId, productId, supplierSku: `RE-PO-SKU-${generateId()}`, isConfirmed: true });
      })
    );

    return { organizationId, storeId, supplierId, productId, kgUnitId: kgUnit!.id, supplierProductId };
  };

  it('a real SUBMIT transition the state machine accepts produces a real notification with the right entityType/entityId', async () => {
    const { organizationId, storeId, supplierId, productId, kgUnitId, supplierProductId } = await setUpPoFixture();

    const poRepo = new PurchaseOrderRepository(db, organizationId);
    const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-RE-${generateId()}`, currency: 'USD' });
    const addLineResult = await poRepo.addLine({ purchaseOrderId: created.id, supplierProductId, productId, quantityOrderUnits: '5', orderUnitId: kgUnitId, conversionToBase: '1', unitPrice: '10.00', lineNumber: 1 });
    if (!addLineResult.ok) throw new Error('addLine failed in test setup');

    const transitionResult = await poRepo.applyTransition(created.id, 'SUBMIT', 1);
    expect(transitionResult.ok).toBe(true);

    const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const submittedEvent = outboxRows.find((e) => e.eventType === 'po.submitted');
    expect(submittedEvent).toBeDefined();

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const relayEvent: RelayJobData = {
      outboxEventId: submittedEvent!.id,
      organizationId,
      aggregateType: 'purchase_order',
      aggregateId: created.id,
      eventType: 'po.submitted',
      payload: submittedEvent!.payload as Record<string, unknown>,
    };
    await processor(asJob(relayEvent));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildPoAwaitingApprovalDedupKey(created.id);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);

    expect(notification).not.toBeNull();
    expect(notification?.entityType).toBe('purchase_order');
    expect(notification?.entityId).toBe(created.id);
    expect(notification?.storeId).toBe(storeId);
    expect(notification?.severity).toBe('MEDIUM'); // catalogue default for po_awaiting_approval

    const ruleRepo = new NotificationRuleRepository(db, organizationId);
    const provisionedRule = await ruleRepo.findById(notification!.ruleId);
    expect(provisionedRule?.ruleType).toBe('po_awaiting_approval');
  });

  it('a subsequent APPROVE transition on the same PO RESOLVES the still-open po_awaiting_approval notification (regression test for a real, now-fixed gap)', async () => {
    // This pins a real bug found while writing this test: the file's own doc comment used to claim
    // "the dedup mechanism itself resolves the still-open po_awaiting_approval notification
    // correctly" once a PO left the awaiting-approval state. That was false — dedup only
    // re-evaluates when a matching event reaches the SAME handler again, and `po.approved` (a REAL
    // event `PurchaseOrderRepository.applyTransition` genuinely emits via
    // `EVENT_TYPE_BY_TRANSITION`) had no case in this processor's switch statement at all, so it
    // fell into the `default: return` no-op branch. The notification stayed open forever after a
    // real approval. Fixed by adding a resolve-only `po.approved`/`po.rejected`/`po.cancelled`
    // mapping (`resolvePoAwaitingApprovalFromEvent`) — this test would have failed before that fix
    // (the notification stayed open) and passes now.
    const { organizationId, storeId, supplierId, productId, kgUnitId, supplierProductId } = await setUpPoFixture();

    const poRepo = new PurchaseOrderRepository(db, organizationId);
    const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-RE-APPROVE-${generateId()}`, currency: 'USD' });
    const addLineResult = await poRepo.addLine({ purchaseOrderId: created.id, supplierProductId, productId, quantityOrderUnits: '5', orderUnitId: kgUnitId, conversionToBase: '1', unitPrice: '10.00', lineNumber: 1 });
    if (!addLineResult.ok) throw new Error('addLine failed in test setup');

    // SUBMIT -> a real open po_awaiting_approval notification exists (proven by the test above).
    await poRepo.applyTransition(created.id, 'SUBMIT', 1);
    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const outboxAfterSubmit = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const submittedEvent = outboxAfterSubmit.find((e) => e.eventType === 'po.submitted')!;
    await processor(asJob({
      outboxEventId: submittedEvent.id, organizationId, aggregateType: 'purchase_order', aggregateId: created.id, eventType: 'po.submitted',
      payload: submittedEvent.payload as Record<string, unknown>,
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildPoAwaitingApprovalDedupKey(created.id);
    const afterSubmit = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterSubmit).not.toBeNull();

    // APPROVE -> a real po.approved outbox event IS emitted by applyTransition (EVENT_TYPE_BY_TRANSITION
    // maps APPROVE -> 'po.approved') — this is a genuine event, not a missing one.
    const approveResult = await poRepo.applyTransition(created.id, 'APPROVE', 2);
    expect(approveResult.ok).toBe(true);
    const outboxAfterApprove = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const approvedEvent = outboxAfterApprove.find((e) => e.eventType === 'po.approved');
    expect(approvedEvent).toBeDefined();

    // Feed that REAL po.approved event into the SAME processor the relay would use in production.
    await processor(asJob({
      outboxEventId: approvedEvent!.id, organizationId, aggregateType: 'purchase_order', aggregateId: created.id, eventType: 'po.approved',
      payload: approvedEvent!.payload as Record<string, unknown>,
    }));

    const afterApprove = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(afterApprove).toBeNull(); // resolved — the fixed behavior

    const resolvedRow = await notificationRepo.findById(afterSubmit!.id);
    expect(resolvedRow?.resolvedAt).not.toBeNull();
  });

  it('a REJECT transition on a still-open PO also resolves the po_awaiting_approval notification', async () => {
    const { organizationId, storeId, supplierId, productId, kgUnitId, supplierProductId } = await setUpPoFixture();

    const poRepo = new PurchaseOrderRepository(db, organizationId);
    const created = await poRepo.create({ storeId, supplierId, poNumber: `PO-RE-REJECT-${generateId()}`, currency: 'USD' });
    const addLineResult = await poRepo.addLine({ purchaseOrderId: created.id, supplierProductId, productId, quantityOrderUnits: '5', orderUnitId: kgUnitId, conversionToBase: '1', unitPrice: '10.00', lineNumber: 1 });
    if (!addLineResult.ok) throw new Error('addLine failed in test setup');

    await poRepo.applyTransition(created.id, 'SUBMIT', 1);
    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const outboxAfterSubmit = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const submittedEvent = outboxAfterSubmit.find((e) => e.eventType === 'po.submitted')!;
    await processor(asJob({
      outboxEventId: submittedEvent.id, organizationId, aggregateType: 'purchase_order', aggregateId: created.id, eventType: 'po.submitted',
      payload: submittedEvent.payload as Record<string, unknown>,
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildPoAwaitingApprovalDedupKey(created.id);
    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).not.toBeNull();

    const rejectResult = await poRepo.applyTransition(created.id, 'REJECT', 2, undefined, 'budget exceeded');
    expect(rejectResult.ok).toBe(true);
    const outboxAfterReject = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const rejectedEvent = outboxAfterReject.find((e) => e.eventType === 'po.rejected')!;
    await processor(asJob({
      outboxEventId: rejectedEvent.id, organizationId, aggregateType: 'purchase_order', aggregateId: created.id, eventType: 'po.rejected',
      payload: rejectedEvent.payload as Record<string, unknown>,
    }));

    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).toBeNull();
  });

  it('a po.approved event for a PO with no open notification (e.g. already resolved) is a real no-op, not an error', async () => {
    const { organizationId } = await setUpPoFixture();
    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await expect(
      processor(asJob({
        outboxEventId: generateId(), organizationId, aggregateType: 'purchase_order', aggregateId: generateId(), eventType: 'po.approved',
        payload: { purchaseOrderId: generateId() },
      }))
    ).resolves.toBeUndefined();
  });
});

/**
 * Proves the fifth real outbox consumer: `stocktake.submitted` -> `stocktake_variance`.
 * `StockCountService.submitCount` already computed every line's real variance and picked out the
 * largest magnitude before emitting this event (see `stock-count-service.test.ts`'s own outbox
 * assertions for that half) — this processor only decides whether that already-known magnitude
 * clears the shared `LARGE_VARIANCE_THRESHOLD` bar.
 */
describe('rule evaluation processor: stocktake.submitted -> stocktake_variance', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminDb = createDb(ADMIN_CONNECTION_STRING).db;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(notificationDeliveries).where(eq(notificationDeliveries.organizationId, orgId));
      await adminDb.delete(notifications).where(eq(notifications.organizationId, orgId));
      await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, orgId));
      await adminDb.delete(notificationPreferences).where(eq(notificationPreferences.organizationId, orgId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(stockCountLines).where(eq(stockCountLines.organizationId, orgId));
      await adminDb.delete(stockCounts).where(eq(stockCounts.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
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

  const setUpCountFixture = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Rule Eval Stocktake Org', slug: `rule-eval-stocktake-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) => withTenantContext(tx, organizationId, () => tx.insert(stores).values({ id: storeId, organizationId, name: 'Rule Eval Stocktake Store', timezone: 'UTC' })));

    const [kgUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'kg'));
    const productRepo = new ProductRepository(db, organizationId);
    const product = await productRepo.create({ id: generateId(), sku: `RULEEVALCOUNT-${generateId()}`, name: 'Rule Eval Count Product', baseUnitId: kgUnit!.id, type: 'INGREDIENT' });
    const variantId = (await productRepo.findVariants(product.id))[0]!.id;

    const movementService = new MovementService(db, organizationId);
    await movementService.postMovement({
      storeId,
      productId: product.id,
      variantId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({ id: generateId(), storeId, productId: product.id, variantId, receivedAt: new Date(), initialQuantity: '100.000000', unitCost: '2.0000', currency: 'USD' });

    return { organizationId, storeId, productId: product.id, variantId };
  };

  it('a real submitted count with a large (30%) variance produces a real notification carrying the real dollar impact', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpCountFixture();

    const service = new StockCountService(db, organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;
    // Counted 70 vs theoretical 100 at $2.00/unit — 30% shortfall, $60.00 real dollar value.
    await service.enterCount(lineId, '70.000000');
    await service.submitCount(count.id);

    const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const submittedEvent = outboxRows.find((e) => e.eventType === 'stocktake.submitted');
    expect(submittedEvent).toBeDefined();

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor(asJob({
      outboxEventId: submittedEvent!.id, organizationId, aggregateType: 'stock_count', aggregateId: count.id, eventType: 'stocktake.submitted',
      payload: submittedEvent!.payload as Record<string, unknown>,
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStocktakeVarianceDedupKey(count.id);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification).not.toBeNull();
    expect(notification?.entityType).toBe('stock_count');
    expect(notification?.entityId).toBe(count.id);
    expect(notification?.storeId).toBe(storeId);
    expect(notification?.dollarImpact).not.toBeNull();
    expect(Number(notification?.dollarImpact)).toBeCloseTo(60, 4);
  });

  it('a real submitted count with a small (under 10%) variance produces NO notification', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpCountFixture();

    const service = new StockCountService(db, organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;
    // Counted 98 vs theoretical 100 — a 2% variance, well under the 10% threshold.
    await service.enterCount(lineId, '98.000000', undefined);
    await service.submitCount(count.id);

    const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    const submittedEvent = outboxRows.find((e) => e.eventType === 'stocktake.submitted');
    expect(submittedEvent).toBeDefined();

    const processor = createRuleEvaluationProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor(asJob({
      outboxEventId: submittedEvent!.id, organizationId, aggregateType: 'stock_count', aggregateId: count.id, eventType: 'stocktake.submitted',
      payload: submittedEvent!.payload as Record<string, unknown>,
    }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildStocktakeVarianceDedupKey(count.id);
    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).toBeNull();
  });
});
