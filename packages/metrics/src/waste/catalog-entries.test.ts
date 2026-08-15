import { describe, expect, it, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import { generateId } from '@retailos/domain';
import {
  auditLogs,
  createDb,
  lots,
  organizations,
  outboxEvents,
  productVariants,
  products,
  stockCountLines,
  stockCounts,
  stockLevels,
  stockMovements,
  stores,
  units,
  withTenantContext,
  LotRepository,
  MovementService,
  StockCountService,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that the 5 newly-registered waste/shrinkage metrics (spec 12 §E) compute
 * correctly through `executeMetric`. `waste_value` (also spec 12 §E) is already covered by
 * `margin/catalog-entries.test.ts` — not re-tested here.
 */
describe('registered waste/shrinkage metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(stockCountLines).where(eq(stockCountLines.organizationId, orgId));
      await adminDb.delete(stockCounts).where(eq(stockCounts.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
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

  afterAll(async () => {
    await adminClient.end();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Waste Metrics Test Org ${organizationId}`,
      slug: `waste-metrics-test-${organizationId}`,
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

  const makeProduct = async (organizationId: string) => {
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `WASTE-${productId}`,
          name: 'Waste Metrics Test Product',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
        });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );
    return { productId, variantId };
  };

  const auth = (permissions: readonly string[] = ['financial:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });

  const from = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  // A function, not a fixed value — `Date.now()` at test-collection time (when this describe body
  // first runs) would freeze `to` before the shrinkage tests' own `t0At`/`approvedAt` timestamps
  // are written mid-test, silently excluding them from their own query window.
  const to = () => new Date(Date.now() + 60 * 1000);

  const postWaste = async (
    organizationId: string,
    storeId: string,
    productId: string,
    variantId: string,
    reasonCode: string,
    quantity: string,
    unitCost: string
  ) => {
    const lotId = generateId();
    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt: from,
      initialQuantity: '1000.000000',
      unitCost,
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '1000.000000',
      unitCost,
      currency: 'USD',
      occurredAt: from,
      sourceType: 'test',
    });
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'WASTE',
      quantity: `-${quantity}`,
      unitCost,
      currency: 'USD',
      reasonCode,
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });
  };

  it('waste_percentage divides real waste value by real cogs', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    await postWaste(organizationId, storeId, productId, variantId, 'SPILLAGE', '10.000000', '2.0000');
    // Real consumption (COGS) of the same product: 40 units at $2.00 each = $80.00.
    const lotRepo = new LotRepository(db, organizationId);
    const lotId2 = generateId();
    await lotRepo.receive({
      id: lotId2,
      storeId,
      productId,
      variantId,
      receivedAt: from,
      initialQuantity: '40.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId: lotId2,
      movementType: 'RECEIPT',
      quantity: '40.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: from,
      sourceType: 'test',
    });
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId: lotId2,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-40.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });

    const result = await executeMetric('waste_percentage', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    // Waste value = 10 x $2.00 = $20.00. COGS = 40 x $2.00 = $80.00. 20/80 = 25%.
    expect(result.value).toBe('25.00');
  });

  it('waste_by_reason returns only the requested reason code, ignoring others', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    await postWaste(organizationId, storeId, productId, variantId, 'SPILLAGE', '10.000000', '2.0000');
    await postWaste(organizationId, storeId, productId, variantId, 'DAMAGED', '3.000000', '5.0000');

    const [spillage, damaged] = await Promise.all([
      executeMetric('waste_by_reason', { storeId, from, to: to(), reasonCode: 'SPILLAGE' }, auth(), plainCtx(organizationId)),
      executeMetric('waste_by_reason', { storeId, from, to: to(), reasonCode: 'DAMAGED' }, auth(), plainCtx(organizationId)),
    ]);
    expect(spillage.value).toBe('20.0000');
    expect(damaged.value).toBe('15.0000');
  });

  it('waste_by_reason is a real zero for a reason code with no matching events', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    await postWaste(organizationId, storeId, productId, variantId, 'SPILLAGE', '10.000000', '2.0000');

    const result = await executeMetric(
      'waste_by_reason',
      { storeId, from, to: to(), reasonCode: 'THEFT_SUSPECTED' },
      auth(),
      plainCtx(organizationId)
    );
    expect(result.value).toBe('0.0000');
  });

  it('expired_value sums only EXPIRED-reason waste', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    await postWaste(organizationId, storeId, productId, variantId, 'EXPIRED', '8.000000', '3.0000');
    await postWaste(organizationId, storeId, productId, variantId, 'DAMAGED', '2.000000', '5.0000');

    const result = await executeMetric('expired_value', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('24.0000');
  });

  it('shrinkage_value sums real frozen variance from an approved stock count (a shortfall)', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const lotRepo = new LotRepository(db, organizationId);
    const lotId = generateId();
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt: from,
      initialQuantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: from,
      sourceType: 'test',
    });

    const service = new StockCountService(db, organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;
    // Counted 85 against a theoretical of 100 -> a real shortfall of 15 (15%, above the 10%
    // threshold, needs a reason code before approval).
    await service.enterCount(lineId, '85.000000');
    await service.submitCount(count.id);
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.update(stockCountLines).set({ reasonCode: 'Spillage during prep' }).where(eq(stockCountLines.id, lineId))
      )
    );
    await service.approveCount(count.id);

    const result = await executeMetric('shrinkage_value', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    // -15 units x $2.00 t0UnitCost = -$30.00.
    expect(result.value).toBe('-30.0000');
  });

  it('shrinkage_value is a real zero with no approved counts in the period, never unknown', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const result = await executeMetric('shrinkage_value', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    expect(result.value).toBe('0.0000');
  });

  it('shrinkage_percentage divides real shrinkage by real cogs', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const { productId, variantId } = await makeProduct(organizationId);
    const lotRepo = new LotRepository(db, organizationId);
    const lotId = generateId();
    await lotRepo.receive({
      id: lotId,
      storeId,
      productId,
      variantId,
      receivedAt: from,
      initialQuantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '100.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: from,
      sourceType: 'test',
    });

    const service = new StockCountService(db, organizationId);
    const count = await service.createCount({ storeId, scope: 'full', productVariantPairs: [{ productId, variantId }] });
    await service.startCount(count.id);
    const lineId = (await service.findLines(count.id))[0]!.id;
    await service.enterCount(lineId, '85.000000');
    await service.submitCount(count.id);
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.update(stockCountLines).set({ reasonCode: 'Spillage during prep' }).where(eq(stockCountLines.id, lineId))
      )
    );
    await service.approveCount(count.id);

    // Real consumption (COGS): 40 units at $2.00 each = $80.00, separate lot so the count's own
    // reconciliation lot draw doesn't interfere with this consumption figure.
    const lotId2 = generateId();
    await lotRepo.receive({
      id: lotId2,
      storeId,
      productId,
      variantId,
      receivedAt: from,
      initialQuantity: '40.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId: lotId2,
      movementType: 'RECEIPT',
      quantity: '40.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: from,
      sourceType: 'test',
    });
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId: lotId2,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-40.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });

    const result = await executeMetric('shrinkage_percentage', { storeId, from, to: to() }, auth(), plainCtx(organizationId));
    // Shrinkage = -$30.00. COGS = $80.00. -30/80 = -37.5%.
    expect(result.value).toBe('-37.50');
  });

  it('executeMetric refuses a caller without financial:read for a waste/shrinkage metric', async () => {
    const { organizationId, storeId } = await setUpOrg();
    await expect(
      executeMetric('waste_percentage', { storeId, from, to: to() }, auth([]), plainCtx(organizationId))
    ).rejects.toThrow(/financial:read/);
  });
});
