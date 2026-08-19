import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId } from '@retailos/domain';
import {
  createDb,
  organizations,
  posConnections,
  posItems,
  stores,
  withTenantContext,
  PosConnectionRepository,
  PosItemRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that `unmapped_pos_items_count` and `data_freshness_lag` compute
 * correctly through `executeMetric` — both were pre-existing pure functions wired into
 * `computeIntegrationHealthSummary` but never individually registered in the catalog until earlier work.
 */
describe('registered integration health metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(posConnections).where(eq(posConnections.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await adminClient.end();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Integration Metrics Test Org ${organizationId}`,
      slug: `integration-metrics-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' })
      )
    );
    return { organizationId, storeId };
  };

  const auth = (permissions: readonly string[] = ['inventory:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });

  it('unmapped_pos_items_count counts a real POS item with no menu-item mapping', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const posItemRepository = new PosItemRepository(db, organizationId);
    await posItemRepository.upsert({
      id: generateId(),
      storeId,
      source: 'square',
      externalId: `UNMAPPED-${organizationId}`,
      name: 'Unmapped Test Item',
    });

    const result = await executeMetric('unmapped_pos_items_count', { storeId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('1');
  });

  it('unmapped_pos_items_count is a real zero when every POS item is mapped', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const result = await executeMetric('unmapped_pos_items_count', { storeId }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('0');
  });

  it('data_freshness_lag is unknown for a connection that has never completed a successful sync', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const posConnectionRepository = new PosConnectionRepository(db, organizationId);
    const connection = await posConnectionRepository.upsert({
      id: generateId(),
      storeId,
      vendor: 'square',
      externalAccountId: `sq-${organizationId}`,
      accessTokenCiphertext: 'iv.ciphertext.tag',
    });

    const result = await executeMetric(
      'data_freshness_lag',
      { connectionId: connection.id },
      auth(),
      plainCtx(organizationId)
    );
    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('data_freshness_lag reports real elapsed minutes since a real recordSuccessfulSync call', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const posConnectionRepository = new PosConnectionRepository(db, organizationId);
    const connection = await posConnectionRepository.upsert({
      id: generateId(),
      storeId,
      vendor: 'square',
      externalAccountId: `sq-${organizationId}`,
      accessTokenCiphertext: 'iv.ciphertext.tag',
    });
    await posConnectionRepository.recordSuccessfulSync(connection.id);

    const result = await executeMetric(
      'data_freshness_lag',
      { connectionId: connection.id },
      auth(),
      plainCtx(organizationId)
    );
    // A sync that just happened is 0 real minutes ago, not 'unknown' — this is a genuine measurement.
    expect(result.value).toBe('0');
  });

  it('data_freshness_lag is unknown for a connectionId that does not exist in this org', async () => {
    const { organizationId } = await setUpOrg();
    const result = await executeMetric(
      'data_freshness_lag',
      { connectionId: generateId() },
      auth(),
      plainCtx(organizationId)
    );
    expect(result.value).toBe('unknown');
  });

  it('executeMetric refuses a caller without inventory:read for an integration health metric', async () => {
    const { organizationId, storeId } = await setUpOrg();
    await expect(
      executeMetric('unmapped_pos_items_count', { storeId }, auth([]), plainCtx(organizationId))
    ).rejects.toThrow(/inventory:read/);
  });
});
