import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from './schema/index';
import { outboxEvents } from './schema/index';
import { generateId } from '@retailos/domain';
import { findUnpublishedOutboxEvents, markOutboxEventsPublished } from './outbox-relay';
import { setUpTwoTenants, type TwoTenantFixture } from './test-support/tenant-fixture';

const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Proves the real read/write halves of the outbox relay against real Postgres — the mechanism
 * that closes the loop on emitting events transactionally with state changes (the outbox
 * pattern). Deliberately uses the ADMIN connection directly (not `TenantScopedRepository`) —
 * `findUnpublishedOutboxEvents` is a genuine cross-tenant sweep by design, matching
 * `findExpiryQueue`'s own precedent, so its own test proves it sees events across BOTH tenants in
 * one call, not that it's scoped to one.
 */
describe('findUnpublishedOutboxEvents + markOutboxEventsPublished: the real relay read/write seam', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let fixture: TwoTenantFixture;

  afterAll(async () => {
    await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, fixture.tenantA.organizationId));
    await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, fixture.tenantB.organizationId));
    await client.end();
    await fixture.cleanup();
  });

  it('a cross-tenant poll sees unpublished events from BOTH tenants, oldest first, and excludes already-published rows', async () => {
    fixture = await setUpTwoTenants();
    client = postgres(ADMIN_CONNECTION_STRING);
    db = drizzle(client, { schema });

    const eventA1 = generateId();
    const eventA2 = generateId();
    const eventB1 = generateId();
    const alreadyPublished = generateId();

    // Insert with explicit createdAt ordering so "oldest first" is actually provable, not
    // coincidental to insertion order.
    await db.insert(outboxEvents).values([
      {
        id: eventA1,
        organizationId: fixture.tenantA.organizationId,
        aggregateType: 'stock_movement',
        aggregateId: generateId(),
        eventType: 'stock.moved',
        payload: { storeId: fixture.tenantA.storeId },
        createdAt: new Date('2026-08-01T00:00:00Z'),
      },
      {
        id: alreadyPublished,
        organizationId: fixture.tenantA.organizationId,
        aggregateType: 'stock_movement',
        aggregateId: generateId(),
        eventType: 'stock.moved',
        payload: {},
        createdAt: new Date('2026-08-01T00:00:01Z'),
        publishedAt: new Date('2026-08-01T00:05:00Z'),
      },
      {
        id: eventB1,
        organizationId: fixture.tenantB.organizationId,
        aggregateType: 'purchase_order',
        aggregateId: generateId(),
        eventType: 'po.created',
        payload: { storeId: fixture.tenantB.storeId },
        createdAt: new Date('2026-08-01T00:00:02Z'),
      },
      {
        id: eventA2,
        organizationId: fixture.tenantA.organizationId,
        aggregateType: 'stock_movement',
        aggregateId: generateId(),
        eventType: 'stock.moved',
        payload: { storeId: fixture.tenantA.storeId },
        createdAt: new Date('2026-08-01T00:00:03Z'),
      },
    ]);

    const unpublished = await findUnpublishedOutboxEvents(db, 100);
    const ids = unpublished.map((e) => e.id);

    expect(ids).toContain(eventA1);
    expect(ids).toContain(eventB1);
    expect(ids).toContain(eventA2);
    expect(ids).not.toContain(alreadyPublished);

    // Oldest-first: eventA1 (00:00:00) must appear before eventB1 (00:00:02) which must appear
    // before eventA2 (00:00:03), among the events this test itself inserted.
    const relevantOrder = ids.filter((id) => [eventA1, eventB1, eventA2].includes(id));
    expect(relevantOrder).toEqual([eventA1, eventB1, eventA2]);
  });

  it('respects the batch limit — a poll with limit=1 returns exactly one row', async () => {
    const unpublished = await findUnpublishedOutboxEvents(db, 1);
    expect(unpublished).toHaveLength(1);
  });

  it('markOutboxEventsPublished marks exactly the given ids, and a second poll no longer sees them', async () => {
    const before = await findUnpublishedOutboxEvents(db, 100);
    const idsToPublish = before.map((e) => e.id);
    expect(idsToPublish.length).toBeGreaterThan(0);

    await markOutboxEventsPublished(db, idsToPublish);

    const after = await findUnpublishedOutboxEvents(db, 100);
    for (const id of idsToPublish) {
      expect(after.map((e) => e.id)).not.toContain(id);
    }
  });

  it('markOutboxEventsPublished with an empty array is a real no-op, not an error', async () => {
    await expect(markOutboxEventsPublished(db, [])).resolves.not.toThrow();
  });

  it('marking an ALREADY-published row again does not throw and does not un-publish it (idempotent)', async () => {
    const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.organizationId, fixture.tenantA.organizationId)).limit(1);
    const someId = rows[0]!.id;
    await markOutboxEventsPublished(db, [someId]);
    await markOutboxEventsPublished(db, [someId]);
    const stillUnpublished = await findUnpublishedOutboxEvents(db, 100);
    expect(stillUnpublished.map((e) => e.id)).not.toContain(someId);
  });
});
