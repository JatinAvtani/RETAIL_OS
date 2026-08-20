import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { resolveApplicableRule, evaluateStockBelowReorder } from '@retailos/domain';
import { Decimal } from 'decimal.js';
import * as schema from '../schema/index';
import { notificationRules } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { NotificationRuleRepository } from './notification-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Proves the real seam between `NotificationRuleRepository.findEnabledByType` (packages/db) and
 * `resolveApplicableRule` (packages/domain, pure) — the "per-tenant thresholds + defaults"
 * mechanism the rule engine needs. The evaluation functions themselves
 * (`evaluateStockBelowReorder`, `evaluateLotExpiring`) are already exhaustively unit-tested as
 * pure functions in packages/domain; what those tests CANNOT prove is that a repository row's
 * real shape (Drizzle's camelCase select output) actually satisfies `CandidateRule` with no
 * adapter needed — this file proves that composition against real Postgres, not a second copy of
 * the pure-function test matrix.
 */
describe('NotificationRuleRepository + resolveApplicableRule: real per-tenant rule resolution', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let fixture: TwoTenantFixture;

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, fixture.tenantA.organizationId));
    await client.end();
    await fixture.cleanup();
  });

  it('a store-specific configured rule overrides the org-wide default for that store, read from real Postgres', async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);

    const db = createScopedDb(client);
    const repo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);

    await repo.create({
      ruleType: 'stock_below_reorder',
      severity: 'MEDIUM',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    await repo.create({
      storeId: fixture.tenantA.storeId,
      ruleType: 'stock_below_reorder',
      severity: 'CRITICAL',
      threshold: {},
      recipientRoles: ['MANAGER', 'OWNER'],
      channels: ['EMAIL', 'SMS'],
    });

    const candidates = await repo.findEnabledByType('stock_below_reorder');
    expect(candidates).toHaveLength(2);

    const applicable = resolveApplicableRule(candidates, fixture.tenantA.storeId);
    expect(applicable?.severity).toBe('CRITICAL');
    expect(applicable?.channels).toEqual(['EMAIL', 'SMS']);

    // The full chain, end to end: a real resolved rule's severity flows into a real evaluation.
    const evaluation = evaluateStockBelowReorder(
      { quantityOnHand: new Decimal('2'), reorderPoint: new Decimal('5') },
      { storeId: fixture.tenantA.storeId, productId: 'product-1', variantId: 'variant-1' },
      applicable!.severity as 'CRITICAL'
    );
    expect(evaluation.fires).toBe(true);
    expect(evaluation.severity).toBe('CRITICAL');
  });

  it('falls back to the org-wide rule for a store with no store-specific override', async () => {
    const db = createScopedDb(client);
    const repo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);

    const candidates = await repo.findEnabledByType('stock_below_reorder');
    // fixture.tenantA has a SECOND store nowhere in `candidates` — simulate by resolving against
    // a storeId that was never configured with its own rule.
    const applicable = resolveApplicableRule(candidates, 'a-different-store-with-no-override');
    expect(applicable?.severity).toBe('MEDIUM');
  });

  it('a disabled store-specific rule is correctly excluded, falling back to the org-wide enabled rule', async () => {
    const db = createScopedDb(client);
    const repo = new NotificationRuleRepository(db, fixture.tenantA.organizationId);

    await repo.create({
      storeId: fixture.tenantA.storeId,
      ruleType: 'lot_expiring',
      enabled: false,
      severity: 'CRITICAL',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });
    await repo.create({
      ruleType: 'lot_expiring',
      severity: 'MEDIUM',
      threshold: {},
      recipientRoles: ['MANAGER'],
      channels: ['EMAIL'],
    });

    const candidates = await repo.findEnabledByType('lot_expiring');
    const applicable = resolveApplicableRule(candidates, fixture.tenantA.storeId);
    // The disabled store-specific row never appears in findEnabledByType's results at all, so
    // resolution correctly falls through to the org-wide row rather than picking the disabled one.
    expect(applicable?.severity).toBe('MEDIUM');
  });

  it('a cross-tenant rule is invisible to resolution — org B never sees org A\'s configured overrides', async () => {
    const dbB = createScopedDb(client);
    const repoB = new NotificationRuleRepository(dbB, fixture.tenantB.organizationId);

    const candidates = await repoB.findEnabledByType('stock_below_reorder');
    expect(candidates).toHaveLength(0);
  });
});
