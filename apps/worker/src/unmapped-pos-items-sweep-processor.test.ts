import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId, buildUnmappedPosItemsDedupKey } from '@retailos/domain';
import {
  createDb,
  withTenantContext,
  organizations,
  stores,
  posItems,
  notifications,
  notificationRules,
  notificationDeliveries,
  notificationPreferences,
  memberships,
  users,
  PosItemRepository,
  NotificationRepository,
} from '@retailos/db';
import { createUnmappedPosItemsSweepProcessor } from './unmapped-pos-items-sweep-processor';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Proves `unmapped_pos_items`'s real trigger end to end against real Postgres: the sweep reads
 * `findUnmappedRankedByVolume`'s real per-store list and turns it into one real, aggregated
 * notification. Not a re-test of the query itself (covered in `pos-item-repository.test.ts`) — what's
 * unique to this layer is the sweep's own composition: does a real unmapped backlog resolve to one
 * real database write, does a second sweep tick not double-notify, and does mapping every item away
 * correctly resolve the notification.
 */
describe('unmapped POS items sweep processor', () => {
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
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  const setUpOrgStore = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Unmapped POS Test Org', slug: `unmapped-pos-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Unmapped POS Store', status: 'active', timezone: 'UTC' })
      )
    );
    return { organizationId, storeId };
  };

  it('a real store with real unmapped POS items produces a real aggregated notification', async () => {
    const { organizationId, storeId } = await setUpOrgStore();
    const posItemRepo = new PosItemRepository(db, organizationId);
    await posItemRepo.upsert({ id: generateId(), storeId, source: 'square', externalId: 'unmapped-1', name: 'Iced Latte (Large)' });
    await posItemRepo.upsert({ id: generateId(), storeId, source: 'square', externalId: 'unmapped-2', name: 'Cold Brew (Medium)' });

    const processor = createUnmappedPosItemsSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    const result = await processor();

    expect(result.notified).toBeGreaterThanOrEqual(1);

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildUnmappedPosItemsDedupKey(storeId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification).not.toBeNull();
    expect(notification?.body).toContain('Iced Latte (Large)');
    expect(notification?.body).toContain('Cold Brew (Medium)');
    // The notification center's own "linked source entity" gap (2026-09 fix): this sweep used to
    // write no entityType/entityId at all, leaving every unmapped_pos_items notification with no
    // real link back to what it's about.
    expect(notification?.entityType).toBe('store');
    expect(notification?.entityId).toBe(storeId);
  });

  it('a store with zero unmapped items produces NO notification for THAT store', async () => {
    const { organizationId, storeId } = await setUpOrgStore();
    // No pos_items rows at all — the honest "nothing to report" case.

    // `findActiveStoresForScheduling` sweeps every `status: 'active'` store in the whole database
    // — a shared dev DB can genuinely have other real active stores with their own real unmapped
    // items left over from unrelated work, so `result.notified` (the GLOBAL count across every
    // store this tick) is not a safe assertion here. The real, scoped claim is: THIS store's own
    // dedup key never gets a notification, regardless of what happens elsewhere in the sweep.
    const processor = createUnmappedPosItemsSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildUnmappedPosItemsDedupKey(storeId);
    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).toBeNull();
  });

  it(
    'a second sweep tick over the SAME still-unmapped backlog updates the existing notification rather than creating a duplicate',
    async () => {
      const { organizationId, storeId } = await setUpOrgStore();
      const posItemRepo = new PosItemRepository(db, organizationId);
      await posItemRepo.upsert({ id: generateId(), storeId, source: 'square', externalId: 'unmapped-repeat', name: 'Mystery Item' });

      const processor = createUnmappedPosItemsSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
      await processor();

      const dedupKey = buildUnmappedPosItemsDedupKey(storeId);
      const notificationRepo = new NotificationRepository(db, organizationId);
      const first = await notificationRepo.findOpenByDedupKey(dedupKey);
      expect(first).not.toBeNull();

      await processor();

      const second = await notificationRepo.findOpenByDedupKey(dedupKey);
      expect(second?.id).toBe(first!.id);

      const allRows = await notificationRepo.findAllByDedupKey(dedupKey);
      expect(allRows).toHaveLength(1);
    },
    // Two full processor() calls, each sweeping every real active store in this shared dev
    // database — genuinely slower than the default 5s budget once many stores have accumulated
    // from unrelated prior test runs, not a real performance regression in the sweep itself.
    // Measured at ~16-17s each; 20s left no headroom and failed under a full concurrent `pnpm
    // test` run while passing in isolation, so it matched the vitest.config.ts ceiling instead.
    60000
  );

  it(
    'mapping every unmapped item away since the last tick RESOLVES the existing open notification',
    async () => {
      const { organizationId, storeId } = await setUpOrgStore();
      const posItemRepo = new PosItemRepository(db, organizationId);
      const itemId = generateId();
      await posItemRepo.upsert({ id: itemId, storeId, source: 'square', externalId: 'unmapped-to-be-mapped', name: 'Soon Mapped Item' });

      const processor = createUnmappedPosItemsSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
      await processor();

      const dedupKey = buildUnmappedPosItemsDedupKey(storeId);
      const notificationRepo = new NotificationRepository(db, organizationId);
      const afterFirst = await notificationRepo.findOpenByDedupKey(dedupKey);
      expect(afterFirst).not.toBeNull();

      // A real mapping decision — a human confirms the item, matching `posItems.mappingStatus`'s
      // real MAPPED transition (no repository method to call here that also creates a real
      // menuItemId, so the status column is updated directly via the admin connection, the same
      // simulation technique used elsewhere for a mutation this test doesn't need the full mapping
      // flow to prove).
      await adminDb.update(posItems).set({ mappingStatus: 'MAPPED' }).where(eq(posItems.id, itemId));

      await processor();

      const afterMapping = await notificationRepo.findOpenByDedupKey(dedupKey);
      expect(afterMapping).toBeNull();
    },
    // Same reason as the tick-dedup test above: real, measured cost, not a regression.
    60000
  );

  it('one store genuinely throwing during evaluation does not prevent another real store in the same tick from being notified', async () => {
    const { organizationId: orgA, storeId: storeA } = await setUpOrgStore();
    const { organizationId: orgB, storeId: storeB } = await setUpOrgStore();
    const posItemRepoA = new PosItemRepository(db, orgA);
    const posItemRepoB = new PosItemRepository(db, orgB);
    await posItemRepoA.upsert({ id: generateId(), storeId: storeA, source: 'square', externalId: 'unmapped-a', name: 'Store A Item' });
    await posItemRepoB.upsert({ id: generateId(), storeId: storeB, source: 'square', externalId: 'unmapped-b', name: 'Store B Item' });

    const spy = vi.spyOn(NotificationRepository.prototype, 'findOpenByDedupKey').mockImplementationOnce(async () => {
      throw new Error('simulated transient failure for orgA');
    });

    try {
      const processor = createUnmappedPosItemsSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
      const result = await processor();
      expect(result.notified).toBeGreaterThanOrEqual(1);

      const notificationRepoB = new NotificationRepository(db, orgB);
      const notificationB = await notificationRepoB.findOpenByDedupKey(buildUnmappedPosItemsDedupKey(storeB));
      expect(notificationB).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
