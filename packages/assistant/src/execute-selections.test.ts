import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { createDb, organizations, stores } from '@retailos/db';
import { executeSelections } from './execute-selections';
import type { ValidatedSelection } from './planning';

/**
 * `executeSelections`'s own dispatch/categorization logic. `executeMetric` itself (the
 * permission check, the actual per-metric arithmetic) is already exhaustively tested in
 * `packages/metrics` — this test proves the try/catch dispatch correctly sorts a real
 * `executeMetric` outcome into `results`/`denied`/`failed`, not that any specific metric computes
 * the right number (that's `packages/metrics`'s own job).
 *
 * The permission-denied path needs no real database at all — `executeMetric` checks
 * `hasPermission` BEFORE `execute` ever runs, so a session with the wrong permission set
 * fails fast without ever touching a repository. One real success case does use a live Postgres
 * connection (a genuinely simple metric, `total_spend`, against a fresh org with zero purchase
 * orders — a real, honest `'0'` result, not a fabricated one) to prove the happy path actually
 * reaches a real `MetricResult`, not just that the dispatch logic compiles.
 */
const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const REAL_STORE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

const auth = (permissions: string[]): AuthContext => ({
  userId: 'user-1',
  organizationId: ORG_ID,
  storeIds: 'ALL',
  role: 'OWNER',
  permissions: new Set(permissions) as AuthContext['permissions'],
});

describe('executeSelections', () => {
  it('sorts a real permission-denied outcome into denied, not results or failed', async () => {
    const selections: ValidatedSelection[] = [
      { metricId: 'net_revenue', params: { storeId: REAL_STORE_ID, from: new Date('2026-08-01'), to: new Date('2026-08-31') } },
    ];
    // No 'financial:read' — executeMetric rejects before ever touching the database, so a fake
    // db handle is safe here (it's never called).
    const result = await executeSelections(selections, auth([]), { db: {} as never, organizationId: ORG_ID, storeIds: 'ALL' });

    expect(result.results).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0]?.metricId).toBe('net_revenue');
    expect(result.denied[0]?.reason).toContain('financial:read');
  });

  it('sorts an unregistered metricId into failed, not denied — a genuinely unexpected outcome since already validates this, but not assumed unreachable', async () => {
    const selections: ValidatedSelection[] = [{ metricId: 'this_metric_does_not_exist', params: {} }];

    const result = await executeSelections(selections, auth(['financial:read']), { db: {} as never, organizationId: ORG_ID, storeIds: 'ALL' });

    expect(result.results).toEqual([]);
    expect(result.denied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.metricId).toBe('this_metric_does_not_exist');
  });

  it('an empty selections list produces an empty, real result — never fabricates a placeholder entry', async () => {
    const result = await executeSelections([], auth(['financial:read']), { db: {} as never, organizationId: ORG_ID, storeIds: 'ALL' });

    expect(result).toEqual({ results: [], resultScopes: [], denied: [], failed: [] });
  });

  describe('a real success case against real Postgres', () => {
    let appConn: ReturnType<typeof createDb>;
    let adminConn: ReturnType<typeof createDb>;

    afterAll(async () => {
      await adminConn.db.delete(stores).where(eq(stores.organizationId, ORG_ID));
      await adminConn.db.delete(organizations).where(eq(organizations.id, ORG_ID));
      await appConn.client.end();
      await adminConn.client.end();
    });

    it('executes a real metric and returns its real MetricResult in results', async () => {
      appConn = createDb(APP_CONNECTION_STRING);
      adminConn = createDb(ADMIN_CONNECTION_STRING);

      await adminConn.db.insert(organizations).values({ id: ORG_ID, name: 'Execute Selections Test Org', slug: `exec-sel-test-${ORG_ID}`, baseCurrency: 'USD' });
      await adminConn.db.insert(stores).values({ id: REAL_STORE_ID, organizationId: ORG_ID, name: 'Test Store', timezone: 'America/New_York' });

      const selections: ValidatedSelection[] = [
        { metricId: 'total_spend', params: { storeId: REAL_STORE_ID, from: new Date('2026-08-01'), to: new Date('2026-08-31') } },
      ];

      const result = await executeSelections(selections, auth(['purchasing:read']), { db: appConn.db, organizationId: ORG_ID, storeIds: 'ALL' });

      expect(result.denied).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.metricId).toBe('total_spend');
      expect(result.results[0]?.value).toBe('0.0000'); // a genuinely real, honest zero (Money's real decimal precision) — no purchase orders exist for this fresh org, not a fabricated placeholder
    });
  });
});
