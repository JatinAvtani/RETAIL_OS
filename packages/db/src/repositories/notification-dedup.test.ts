import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { resolveDedupAction } from '@retailos/domain';
import * as schema from '../schema/index';
import { notifications, notificationRules } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { NotificationRepository, NotificationRuleRepository } from './notification-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Proves the real seam between `resolveDedupAction` (`@retailos/domain`, pure) and
 * `NotificationRepository.upsertByDedupKey`/`findOpenByDedupKey` (`packages/db`) against real
 * Postgres — the "existing? UPDATE, don't re-send" + "condition cleared? RESOLVE" mechanism this
 * pipeline exists to build. Confirmed with the user: suppression is condition-based, not
 * time-based — a notification stays open and updates in place for as long as its dedup_key keeps
 * firing, and resolves the moment an evaluation of that key stops firing.
 */
describe('resolveDedupAction + NotificationRepository: the real CREATE/UPDATE/RESOLVE cycle', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let fixture: TwoTenantFixture;
  let ruleId: string;

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(notifications).where(eq(notifications.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, fixture.tenantA.organizationId));
    await client.end();
    await fixture.cleanup();
  });

  it('the full cycle: fires with nothing open -> CREATE; fires again -> UPDATE the SAME row; stops firing -> RESOLVE; fires again -> a genuinely NEW row', async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);

    const db = createScopedDb(client);
    const ruleRepo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);
    const rule = await ruleRepo.create({
      ruleType: 'stock_below_reorder',
      threshold: {},
      severity: 'HIGH',
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    ruleId = rule.id;

    const repo = new NotificationRepository(db, fixture.tenantA.organizationId);
    const dedupKey = `stock_below_reorder:${fixture.tenantA.storeId}:cycle-test`;

    // Round 1: fires, nothing open -> CREATE.
    const existing1 = await repo.findOpenByDedupKey(dedupKey);
    const action1 = resolveDedupAction(true, existing1);
    expect(action1.kind).toBe('CREATE');
    const { id: firstId } = await repo.upsertByDedupKey({
      ruleId,
      severity: 'HIGH',
      title: 'Flour low (3 remaining)',
      body: 'Flour is at 3 units, below the reorder point of 5.',
      dedupKey,
    });

    // Round 2: still fires (quantity dropped further) -> the SAME dedup key, resolveDedupAction says UPDATE.
    const existing2 = await repo.findOpenByDedupKey(dedupKey);
    expect(existing2?.id).toBe(firstId);
    const action2 = resolveDedupAction(true, existing2);
    expect(action2).toEqual({ kind: 'UPDATE', existingId: firstId });
    const { id: secondId } = await repo.upsertByDedupKey({
      ruleId,
      severity: 'CRITICAL',
      title: 'Flour low (1 remaining)',
      body: 'Flour is at 1 unit, below the reorder point of 5.',
      dedupKey,
    });
    // The real row id is unchanged — an UPSERT, never a second row.
    expect(secondId).toBe(firstId);
    const afterUpdate = await repo.findById(firstId);
    expect(afterUpdate?.title).toBe('Flour low (1 remaining)');
    expect(afterUpdate?.severity).toBe('CRITICAL');

    const allRowsForKey = await repo.findAllByDedupKey(dedupKey);
    expect(allRowsForKey).toHaveLength(1);

    // Round 3: a restock happens — the condition no longer fires. resolveDedupAction says RESOLVE.
    const existing3 = await repo.findOpenByDedupKey(dedupKey);
    const action3 = resolveDedupAction(false, existing3);
    expect(action3).toEqual({ kind: 'RESOLVE', existingId: firstId });
    await repo.markResolved(firstId);

    const afterResolve = await repo.findOpenByDedupKey(dedupKey);
    expect(afterResolve).toBeNull();

    // Round 4: stock drops below reorder AGAIN, later. Nothing open -> a genuinely fresh CREATE,
    // not blocked by the now-resolved row (the whole point of the partial unique index).
    const existing4 = await repo.findOpenByDedupKey(dedupKey);
    const action4 = resolveDedupAction(true, existing4);
    expect(action4.kind).toBe('CREATE');
    const { id: thirdId } = await repo.upsertByDedupKey({
      ruleId,
      severity: 'HIGH',
      title: 'Flour low again',
      body: 'Flour is at 4 units, below the reorder point of 5.',
      dedupKey,
    });
    expect(thirdId).not.toBe(firstId);

    const allRowsAfterFreshFire = await repo.findAllByDedupKey(dedupKey);
    expect(allRowsAfterFreshFire).toHaveLength(2);
    expect(allRowsAfterFreshFire.filter((row) => row.resolvedAt === null)).toHaveLength(1);
  });

  it('resolveDedupAction with nothing firing and nothing open is a real NO_OP — no repository call needed at all', async () => {
    const db = createScopedDb(client);
    const repo = new NotificationRepository(db, fixture.tenantA.organizationId);
    const existing = await repo.findOpenByDedupKey('a-dedup-key-that-was-never-created');
    const action = resolveDedupAction(false, existing);
    expect(action).toEqual({ kind: 'NO_OP' });
  });
});
