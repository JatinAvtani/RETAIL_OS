import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { buildDailyBriefingDedupKey, generateId } from '@retailos/domain';
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
  NotificationDeliveryRepository,
} from '@retailos/db';
import { createBriefingProcessor } from './briefing-processor';
import type { BriefingJobData } from '@retailos/queue';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const asJob = (data: BriefingJobData): Job<BriefingJobData> => ({ data }) as Job<BriefingJobData>;

/**
 * Proves the real scheduled-generation-and-delivery chain against real Postgres — reuses
 * the SAME `rankExceptions`/metric-calling machinery `assistant.briefing`'s own tests already cover
 * at the pure-function level; what's unique here is the integration seam this adds: does a
 * genuinely calm store produce NO notification (the explicit anti-pattern check), does a
 * real exception produce a real INFO-severity `notifications` row via `upsertByDedupKey`, and does
 * that fan out through the real delivery pipeline exactly like any other alert type.
 */
describe('briefing processor', () => {
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

  const setUpOrgStore = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Briefing Test Org', slug: `briefing-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Briefing Store', timezone: 'UTC' })
      )
    );
    return { organizationId, storeId };
  };

  it('a genuinely calm store produces NO notification at all — the plan\'s own explicit anti-pattern check', async () => {
    const { organizationId, storeId } = await setUpOrgStore();

    // No products, no movements, no documents -- every one of the 8 exception metrics genuinely
    // resolves to zero/no rows for a brand-new store.
    const processor = createBriefingProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: 'redis://unused-for-this-test:0', geminiApiKey: undefined });
    await processor(asJob({ organizationId, storeId }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const today = new Date().toISOString().slice(0, 10);
    const dedupKey = buildDailyBriefingDedupKey(storeId, today);
    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).toBeNull();
  });

  it('a real exception (negative stock) produces a real INFO-severity notification, and fans out to a real accepted OWNER', async () => {
    const { organizationId, storeId } = await setUpOrgStore();

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `BRIEF-${productId}`, name: 'Briefing Product', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );

    // A real COUNT_ADJUSTMENT to a genuinely negative on-hand quantity — the same real signal
    // negative_stock_incidents reads, no mocked repository involved.
    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'COUNT_ADJUSTMENT', quantity: '-5.000000', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    // memberships is FORCE RLS — insert via the admin connection.
    const ownerUserId = generateId();
    await adminDb.insert(users).values({ id: ownerUserId, email: `owner-${ownerUserId}@example.test` });
    await adminDb.insert(memberships).values({ id: generateId(), organizationId, userId: ownerUserId, role: 'OWNER', storeIds: null, acceptedAt: new Date() });

    const processor = createBriefingProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: process.env.TEST_REDIS_URL ?? 'redis://localhost:16379', geminiApiKey: undefined });
    await processor(asJob({ organizationId, storeId }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const today = new Date().toISOString().slice(0, 10);
    const dedupKey = buildDailyBriefingDedupKey(storeId, today);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification).not.toBeNull();
    expect(notification?.severity).toBe('INFO');
    expect(notification?.title).toBe('Daily briefing');
    // With no Gemini key configured, the body degrades to the honest fallback (real labels joined),
    // never a fabricated narration -- proving the degrade path, not just the happy path.
    expect(notification?.body).toContain('negative stock');

    const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
    const deliveries = (await deliveryRepo.findForUser(ownerUserId)).filter((d) => d.notificationId === notification!.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.channel).toBe('EMAIL');
  });

  it('a SECOND run for the SAME day with the SAME exception updates the existing notification (UPDATE, not CREATE) and does NOT re-deliver', async () => {
    const { organizationId, storeId } = await setUpOrgStore();

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({ id: productId, organizationId, sku: `BRIEF2-${productId}`, name: 'Briefing Product 2', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );

    const stockLevelRepo = new StockLevelRepository(db, organizationId);
    await stockLevelRepo.recordAndProject({
      id: generateId(), storeId, productId, variantId, movementType: 'COUNT_ADJUSTMENT', quantity: '-3.000000', currency: 'USD', occurredAt: new Date(), sourceType: 'test',
    });

    const ownerUserId = generateId();
    await adminDb.insert(users).values({ id: ownerUserId, email: `owner2-${ownerUserId}@example.test` });
    await adminDb.insert(memberships).values({ id: generateId(), organizationId, userId: ownerUserId, role: 'OWNER', storeIds: null, acceptedAt: new Date() });

    const processor = createBriefingProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: process.env.TEST_REDIS_URL ?? 'redis://localhost:16379', geminiApiKey: undefined });
    await processor(asJob({ organizationId, storeId }));
    await processor(asJob({ organizationId, storeId }));

    const notificationRepo = new NotificationRepository(db, organizationId);
    const today = new Date().toISOString().slice(0, 10);
    const dedupKey = buildDailyBriefingDedupKey(storeId, today);
    const allForKey = await notificationRepo.findAllByDedupKey(dedupKey);
    expect(allForKey).toHaveLength(1); // one row, updated in place, never a duplicate

    const deliveryRepo = new NotificationDeliveryRepository(db, organizationId);
    const deliveries = (await deliveryRepo.findForUser(ownerUserId)).filter((d) => d.notificationId === allForKey[0]!.id);
    expect(deliveries).toHaveLength(1); // NOT two -- the second run's fan-out was correctly skipped
  });
});
