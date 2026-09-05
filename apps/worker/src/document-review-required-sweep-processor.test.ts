import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId, buildDocumentReviewRequiredDedupKey } from '@retailos/domain';
import {
  createDb,
  withTenantContext,
  organizations,
  stores,
  documents,
  notifications,
  notificationRules,
  notificationDeliveries,
  notificationPreferences,
  memberships,
  users,
  NotificationRepository,
} from '@retailos/db';
import { createDocumentReviewRequiredSweepProcessor } from './document-review-required-sweep-processor';

const APP_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Proves `document_review_required`'s real trigger end to end against real Postgres: the sweep reads
 * `findDocumentsReviewRequired`'s real cross-tenant `WHERE status = 'REVIEW_REQUIRED'` list and turns
 * it into one real, aggregated per-store notification. Not a re-test of the query itself — what's
 * unique to this layer is the sweep's own composition: does a real review-required backlog resolve
 * to one real database write, does a second sweep tick not double-notify, and does resolving every
 * document away correctly resolve the notification.
 *
 * Every assertion is scoped to THIS test's own organization/store (`findUnresolvedForStore` /
 * `findOpenByDedupKey`), never the sweep-wide `result.notified` count — the sweep genuinely iterates
 * every real document across the whole shared dev database, which can carry other real
 * REVIEW_REQUIRED rows left over from unrelated work.
 */
describe('document review-required sweep processor', () => {
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
      await adminDb.delete(documents).where(eq(documents.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  const setUpOrgStore = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: 'Doc Review Test Org', slug: `doc-review-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Doc Review Store', status: 'active', timezone: 'UTC' })
      )
    );
    return { organizationId, storeId };
  };

  const insertReviewRequiredDocument = async (organizationId: string, storeId: string, storageKey: string) =>
    db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(documents).values({
          id: generateId(),
          organizationId,
          storeId,
          type: 'INVOICE',
          source: 'UPLOAD',
          status: 'REVIEW_REQUIRED',
          storageKey,
          contentHash: `hash-${storageKey}`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          version: 1,
        })
      )
    );

  it('a real store with a real document stuck at REVIEW_REQUIRED produces a real notification', async () => {
    const { organizationId, storeId } = await setUpOrgStore();
    await insertReviewRequiredDocument(organizationId, storeId, `doc-review-${organizationId}-1`);

    const processor = createDocumentReviewRequiredSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildDocumentReviewRequiredDedupKey(storeId);
    const notification = await notificationRepo.findOpenByDedupKey(dedupKey);
    expect(notification).not.toBeNull();
    expect(notification?.entityType).toBe('store');
    expect(notification?.entityId).toBe(storeId);
    expect(notification?.body).toContain('INVOICE document');
  });

  it('a store with zero review-required documents produces NO notification for THAT store', async () => {
    const { organizationId, storeId } = await setUpOrgStore();
    // No documents rows at all — the honest "nothing to report" case.

    const processor = createDocumentReviewRequiredSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
    await processor();

    const notificationRepo = new NotificationRepository(db, organizationId);
    const dedupKey = buildDocumentReviewRequiredDedupKey(storeId);
    expect(await notificationRepo.findOpenByDedupKey(dedupKey)).toBeNull();
  });

  it(
    'a second sweep tick over the SAME still-review-required backlog updates the existing notification rather than creating a duplicate',
    async () => {
      const { organizationId, storeId } = await setUpOrgStore();
      await insertReviewRequiredDocument(organizationId, storeId, `doc-review-repeat-${organizationId}`);

      const processor = createDocumentReviewRequiredSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
      await processor();

      const dedupKey = buildDocumentReviewRequiredDedupKey(storeId);
      const notificationRepo = new NotificationRepository(db, organizationId);
      const first = await notificationRepo.findOpenByDedupKey(dedupKey);
      expect(first).not.toBeNull();

      await processor();

      const second = await notificationRepo.findOpenByDedupKey(dedupKey);
      expect(second?.id).toBe(first!.id);

      const allRows = await notificationRepo.findAllByDedupKey(dedupKey);
      expect(allRows).toHaveLength(1);
    },
    20000
  );

  it(
    'resolving every review-required document away since the last tick RESOLVES the existing open notification',
    async () => {
      const { organizationId, storeId } = await setUpOrgStore();
      const documentId = generateId();
      await db.transaction((tx) =>
        withTenantContext(tx, organizationId, () =>
          tx.insert(documents).values({
            id: documentId,
            organizationId,
            storeId,
            type: 'INVOICE',
            source: 'UPLOAD',
            status: 'REVIEW_REQUIRED',
            storageKey: `doc-review-to-be-resolved-${organizationId}`,
            contentHash: `hash-resolved-${organizationId}`,
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            version: 1,
          })
        )
      );

      const processor = createDocumentReviewRequiredSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
      await processor();

      const dedupKey = buildDocumentReviewRequiredDedupKey(storeId);
      const notificationRepo = new NotificationRepository(db, organizationId);
      const afterFirst = await notificationRepo.findOpenByDedupKey(dedupKey);
      expect(afterFirst).not.toBeNull();

      // A human resolves the document (approves it) — a real status transition away from
      // REVIEW_REQUIRED, matching `unmapped-pos-items-sweep-processor.test.ts`'s own simulation
      // technique for a mutation this test doesn't need the full approval flow to prove.
      await adminDb.update(documents).set({ status: 'APPROVED' }).where(eq(documents.id, documentId));

      await processor();

      const afterResolution = await notificationRepo.findOpenByDedupKey(dedupKey);
      expect(afterResolution).toBeNull();
    },
    20000
  );

  it('one store genuinely throwing during evaluation does not prevent another real store in the same tick from being notified', async () => {
    const { organizationId: orgA, storeId: storeA } = await setUpOrgStore();
    const { organizationId: orgB, storeId: storeB } = await setUpOrgStore();
    await insertReviewRequiredDocument(orgA, storeA, `doc-review-a-${orgA}`);
    await insertReviewRequiredDocument(orgB, storeB, `doc-review-b-${orgB}`);

    const spy = vi.spyOn(NotificationRepository.prototype, 'findOpenByDedupKey').mockImplementationOnce(async () => {
      throw new Error('simulated transient failure for orgA');
    });

    try {
      const processor = createDocumentReviewRequiredSweepProcessor({ databaseUrl: ADMIN_CONNECTION_STRING, redisUrl: REDIS_URL });
      await processor();

      const notificationRepoB = new NotificationRepository(db, orgB);
      const notificationB = await notificationRepoB.findOpenByDedupKey(buildDocumentReviewRequiredDedupKey(storeB));
      expect(notificationB).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
