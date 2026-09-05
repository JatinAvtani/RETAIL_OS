import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import {
  auditLogs,
  organizations,
  outboxEvents,
  products,
  productVariants,
  purchaseOrderLines,
  purchaseOrders,
  stockLevels,
  stockMovements,
  stores,
  supplierPrices,
  suppliers,
  supplierProducts,
  units,
  users,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { MovementService } from './movement-service';
import { sourceReorderCandidates, applyApprovedReorderDraft } from './reorder-draft-approval-service';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * proves the ONLY write path from an approved `ActionDraftResult` to a real
 * `purchase_orders`/`purchase_order_lines` row. Reuses `reorder-suggestions.test.ts`'s own real
 * seeding pattern (real `MovementService.postMovement` calls, never a raw insert) since candidate
 * sourcing IS `findReorderSuggestions` — a divergent fixture here would just prove a different,
 * less honest function.
 */
describe('applyApprovedReorderDraft / sourceReorderCandidates', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let supplierId: string;
  let kgUnitId: string;
  let actorUserId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Reorder Approval Test Org',
      slug: `reorder-approval-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    supplierId = generateId();
    await adminDb.insert(suppliers).values({
      id: supplierId,
      organizationId,
      name: 'Approval Test Supplier',
      leadTimeDaysContracted: 2,
      leadTimeDaysMeasured: 2,
    });

    const [kg] = await adminDb.select().from(units).where(eq(units.code, 'kg'));
    kgUnitId = kg!.id;

    actorUserId = generateId();
    await adminDb.insert(users).values({ id: actorUserId, email: `reorder-approval-test-${actorUserId}@example.test` });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, organizationId));
    await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, organizationId));
    const orgSupplierProducts = await adminDb
      .select({ id: supplierProducts.id })
      .from(supplierProducts)
      .where(eq(supplierProducts.organizationId, organizationId));
    for (const { id } of orgSupplierProducts) {
      await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, id));
    }
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, organizationId));
    const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, organizationId));
    for (const { id } of orgProducts) {
      await adminDb.delete(productVariants).where(eq(productVariants.productId, id));
    }
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(users).where(eq(users.id, actorUserId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  const seedProduct = async (adminDb: ReturnType<typeof drizzle<typeof schema>>, sku: string) => {
    const productId = generateId();
    await adminDb.insert(products).values({ id: productId, organizationId, sku, name: sku, baseUnitId: kgUnitId, type: 'INGREDIENT' });
    const variantId = generateId();
    await adminDb.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
    return { productId, variantId };
  };

  const seedSupplierProductWithPrice = async (
    adminDb: ReturnType<typeof drizzle<typeof schema>>,
    productId: string,
    supplierSku: string,
    unitPrice: string
  ) => {
    const supplierProductId = generateId();
    await adminDb.insert(supplierProducts).values({
      id: supplierProductId,
      organizationId,
      supplierId,
      productId,
      supplierSku,
      isConfirmed: true,
      packSize: '12',
      packUnitId: kgUnitId,
      conversionToBase: '1',
    });
    await adminDb.insert(supplierPrices).values({
      id: generateId(),
      supplierProductId,
      unitPrice,
      currency: 'USD',
      validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      validTo: null,
    });
    return supplierProductId;
  };

  const seedLowStockWithConsumption = async (productId: string, variantId: string) => {
    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '5',
      unitCost: '3.00',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      sourceType: 'TEST',
    });
    for (let i = 0; i < 10; i++) {
      await movementService.postMovement({
        storeId,
        productId,
        variantId,
        movementType: 'SALE_CONSUMPTION',
        quantity: '-1',
        currency: 'USD',
        occurredAt: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000),
        sourceType: 'TEST',
      });
    }
  };

  it('sourceReorderCandidates exposes the real unitPrice on each candidate row, never null when a confirmed price exists', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const { productId, variantId } = await seedProduct(adminDb, 'APPROVE-TEST-1');
    const supplierProductId = await seedSupplierProductWithPrice(adminDb, productId, 'SUP-APPROVE-1', '4.50');
    await seedLowStockWithConsumption(productId, variantId);

    const { candidates, bySupplierProductId } = await sourceReorderCandidates(createScopedDb(client), organizationId, storeId);

    expect(candidates.some((c) => c.candidateId === supplierProductId)).toBe(true);
    const resolved = bySupplierProductId.get(supplierProductId);
    expect(resolved?.suggestion.unitPrice).toBe('4.5000');
  });

  it('approving a real draft creates a real purchase_orders row and a real, correctly-priced line', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const { productId, variantId } = await seedProduct(adminDb, 'APPROVE-TEST-2');
    const supplierProductId = await seedSupplierProductWithPrice(adminDb, productId, 'SUP-APPROVE-2', '2.00');
    await seedLowStockWithConsumption(productId, variantId);

    const { bySupplierProductId } = await sourceReorderCandidates(createScopedDb(client), organizationId, storeId);
    const resolved = bySupplierProductId.get(supplierProductId);
    expect(resolved).toBeDefined();

    const result = await applyApprovedReorderDraft(
      createScopedDb(client),
      organizationId,
      storeId,
      actorUserId,
      { lines: [{ candidateId: supplierProductId, label: 'test', quantity: resolved!.suggestion.suggestion.quantity.amount, unitLabel: 'kg' }] }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejections).toEqual([]);

    const [poRow] = await adminDb.select().from(purchaseOrders).where(eq(purchaseOrders.id, result.purchaseOrderId));
    expect(poRow).toBeDefined();
    expect(poRow!.supplierId).toBe(supplierId);
    expect(poRow!.status).toBe('DRAFT');

    const lines = await adminDb.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, result.purchaseOrderId));
    expect(lines).toHaveLength(1);
    // The real price this line was written with must be the SAME confirmed price
    // sourceReorderCandidates surfaced — never a fabricated or re-derived figure (I2/I5).
    expect(new Decimal(lines[0]!.unitPrice).toString()).toBe('2');
    expect(new Decimal(lines[0]!.lineTotal).greaterThan(0)).toBe(true);
  });

  it('a candidateId with no confirmed price is rejected, never written with a fabricated 0 (I5/I7)', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const { productId, variantId } = await seedProduct(adminDb, 'APPROVE-TEST-3');
    // Confirmed supplier product, but NO supplierPrices row inserted.
    const supplierProductId = generateId();
    await adminDb.insert(supplierProducts).values({
      id: supplierProductId,
      organizationId,
      supplierId,
      productId,
      supplierSku: 'SUP-APPROVE-3',
      isConfirmed: true,
      packSize: '12',
      packUnitId: kgUnitId,
      conversionToBase: '1',
    });
    await seedLowStockWithConsumption(productId, variantId);

    const result = await applyApprovedReorderDraft(
      createScopedDb(client),
      organizationId,
      storeId,
      actorUserId,
      { lines: [{ candidateId: supplierProductId, label: 'test', quantity: new Decimal('5'), unitLabel: 'kg' }] }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either rejected outright (no lines survive) or the single line lands in `rejections` —
    // either way, NO purchase_order_lines row for this candidate exists with a fabricated price.
    const orgPOs = await adminDb.select().from(purchaseOrders).where(eq(purchaseOrders.organizationId, organizationId));
    expect(orgPOs).toHaveLength(0);
  });

  it('a candidateId that does not resolve to any current suggestion is rejected, never a stale-data guess', async () => {
    const result = await applyApprovedReorderDraft(
      createScopedDb(client),
      organizationId,
      storeId,
      actorUserId,
      { lines: [{ candidateId: 'nonexistent-candidate-id', label: 'ghost', quantity: new Decimal('1'), unitLabel: 'kg' }] }
    );

    expect(result.ok).toBe(false);
  });
});
