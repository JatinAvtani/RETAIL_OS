import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from './schema/index';
import { organizations, productVariants, products, stockMovements, stores, units } from './schema/index';
import { createScopedDb } from './tenant-repository';
import { StockMovementRepository } from './repositories/stock-movement-repository';
import { ProductRepository } from './repositories/product-repository';
import {
  checkDefaultPartitionOverflow,
  ensureFutureStockMovementPartitions,
  planStockMovementsMonthlyPartition,
} from './stock-movements-partitions';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Proves `ensureFutureStockMovementPartitions` against a real Postgres database — the genuinely
 * privileged half of partition maintenance that the pure unit tests
 * (`stock-movements-partitions.test.ts`) cannot cover: DDL actually landing, idempotency across
 * repeated real runs, and — the whole point of this mechanism — a row with an `occurred_at` in a
 * newly-created month actually being routed by Postgres into THAT partition, not the DEFAULT
 * catch-all `0014_stock_movements.sql` seeded as a safety net.
 *
 * Uses the ADMIN connection directly for the DDL calls (same role `db:migrate` uses) — matching
 * `outbox-relay.test.ts`'s own precedent for a mechanism that genuinely requires elevated
 * privilege, not `TenantScopedRepository`. A far-future month (deliberately many years out) is
 * used for the "new partition" assertions specifically so this test can never collide with
 * whatever real current-month partition a live worker running this same job elsewhere may have
 * already created.
 */
describe('ensureFutureStockMovementPartitions + checkDefaultPartitionOverflow: real partition DDL', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let unitId: string;
  let productId: string;
  let variantId: string;

  // Far enough in the future that no other test/migration could plausibly have already created
  // this month's partition, so "created" is unambiguously provable.
  const FAR_FUTURE_MONTH = new Date('2099-05-01T00:00:00Z');
  const FAR_FUTURE_PARTITION_NAME = planStockMovementsMonthlyPartition(FAR_FUTURE_MONTH).tableName;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Partition Maintenance Test Org',
      slug: `partition-maintenance-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({
      id: storeId,
      organizationId,
      name: 'Main Store',
      timezone: 'America/New_York',
    });

    const existingUnit = await adminDb.select().from(units).where(eq(units.code, 'g'));
    unitId = existingUnit[0]?.id ?? generateId();
    if (!existingUnit[0]) {
      await adminDb.insert(units).values({ id: unitId, code: 'g', dimension: 'MASS', isBase: true });
    }

    const productRepo = new ProductRepository(createScopedDb(client), organizationId);
    const product = await productRepo.create({
      id: generateId(),
      sku: `SKU-${generateId()}`,
      name: 'Partition Test Ingredient',
      baseUnitId: unitId,
      type: 'INGREDIENT',
    });
    productId = product.id;
    const variants = await productRepo.findVariants(productId);
    const defaultVariant = variants[0];
    if (!defaultVariant) throw new Error('Test setup: product has no default variant.');
    variantId = defaultVariant.id;
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    await adminDb.delete(productVariants).where(eq(productVariants.productId, productId));
    await adminDb.delete(products).where(eq(products.id, productId));
    await adminDb.delete(stores).where(eq(stores.id, storeId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));

    // Best-effort cleanup of the far-future partition this test creates — DROP TABLE is DDL, not
    // an UPDATE/DELETE on the ledger itself (I3 is about row mutation, not the schema-management
    // machinery this whole module is), and leaving a real, empty, far-future partition behind
    // across repeated test runs would otherwise accumulate indefinitely.
    await adminClient.unsafe(`DROP TABLE IF EXISTS "${FAR_FUTURE_PARTITION_NAME}"`);

    await client.end();
    await adminClient.end();
  });

  it('creates the expected partition tables for a far-future month + months-ahead window, visible in pg_catalog', async () => {
    const result = await ensureFutureStockMovementPartitions(adminClient, FAR_FUTURE_MONTH, 2);

    expect(result.created).toContain(FAR_FUTURE_PARTITION_NAME);
    expect(result.ensured).toEqual(
      expect.arrayContaining([
        'stock_movements_2099_05',
        'stock_movements_2099_06',
        'stock_movements_2099_07',
      ])
    );

    const rows = await adminClient<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent
      WHERE parent.relname = 'stock_movements'
        AND c.relname = ${FAR_FUTURE_PARTITION_NAME}
    `;
    expect(rows).toHaveLength(1);
  });

  it('is idempotent — running it again for the same window does not error and reports nothing new created', async () => {
    await expect(ensureFutureStockMovementPartitions(adminClient, FAR_FUTURE_MONTH, 2)).resolves.not.toThrow();

    const second = await ensureFutureStockMovementPartitions(adminClient, FAR_FUTURE_MONTH, 2);
    expect(second.created).not.toContain(FAR_FUTURE_PARTITION_NAME);
    expect(second.ensured).toContain(FAR_FUTURE_PARTITION_NAME);
  });

  it('a stock_movements row with occurred_at inside the new partition\'s range is physically stored in that partition, not DEFAULT', async () => {
    const repo = new StockMovementRepository(createScopedDb(client), organizationId);
    const id = generateId();
    const occurredAt = new Date('2099-05-15T12:00:00Z');

    await repo.record({
      id,
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '10.000000',
      unitCost: '1.5000',
      currency: 'USD',
      occurredAt,
      sourceType: 'manual',
    });

    // pg_partition_tree-equivalent: ask Postgres directly which physical partition this row's
    // tableoid actually resolves to. This is the real test — the partition existing (asserted
    // above via pg_catalog) is necessary but not sufficient; Postgres could in principle still
    // route the row to DEFAULT if the bounds were wrong.
    const rows = await adminClient<{ partition_name: string }[]>`
      SELECT tableoid::regclass::text AS partition_name
      FROM stock_movements
      WHERE id = ${id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.partition_name).toBe(FAR_FUTURE_PARTITION_NAME);
    expect(rows[0]!.partition_name).not.toBe('stock_movements_default');
  });

  it('checkDefaultPartitionOverflow reports the real current row count of stock_movements_default', async () => {
    const before = await checkDefaultPartitionOverflow(adminClient, 0);
    expect(before.rowCount).toBeGreaterThanOrEqual(0);

    // Force a real row into DEFAULT deliberately, using an occurred_at far outside any pre-created
    // partition range (year 1999 — long before this migration's own seeded partition and every
    // month this test/job creates), to prove the detector actually reacts to a real overflow
    // rather than always reporting zero.
    const overflowId = generateId();
    const repo = new StockMovementRepository(createScopedDb(client), organizationId);
    await repo.record({
      id: overflowId,
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '1.000000',
      unitCost: '1.0000',
      currency: 'USD',
      occurredAt: new Date('1999-01-01T00:00:00Z'),
      sourceType: 'manual',
    });

    const after = await checkDefaultPartitionOverflow(adminClient, 0);
    expect(after.rowCount).toBeGreaterThan(before.rowCount);
    expect(after.overThreshold).toBe(true);

    const partitionRows = await adminClient<{ partition_name: string }[]>`
      SELECT tableoid::regclass::text AS partition_name
      FROM stock_movements
      WHERE id = ${overflowId}
    `;
    expect(partitionRows[0]!.partition_name).toBe('stock_movements_default');
  });
});
