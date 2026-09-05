import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import {
  auditLogs,
  notificationRules,
  notifications,
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
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { MovementService } from '../repositories/movement-service';
import { findReorderSuggestions } from './reorder-suggestions';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('findReorderSuggestions', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let supplierId: string;
  let kgUnitId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Reorder Suggestions Test Org',
      slug: `reorder-suggestions-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    supplierId = generateId();
    await adminDb.insert(suppliers).values({
      id: supplierId,
      organizationId,
      name: 'Test Supplier',
      leadTimeDaysContracted: 2,
      leadTimeDaysMeasured: 2,
    });

    const [kg] = await adminDb.select().from(units).where(eq(units.code, 'kg'));
    kgUnitId = kg!.id;
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(purchaseOrderLines).where(eq(purchaseOrderLines.organizationId, organizationId));
    await adminDb.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, organizationId));
    // supplier_prices/product_variants carry no organizationId column of their own (RLS uses a
    // subquery-based policy instead) — delete via their real parent-scoped columns.
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
    // MovementService.postMovement writes real outbox_events/audit_logs rows in the same
    // transaction as the movement — both reference organizations and must be cleaned up before
    // the org row itself can be deleted.
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    // `notifications.store_id` references `stores`, so these must go BEFORE the store rows. This
    // org grew notifications only once the investigation trigger began sweeping more rule types —
    // the fixture itself never creates one, which is why the FK held until then. Deleting by
    // organization (not by store) also catches any org-scoped notification with a null store_id.
    await adminDb.delete(notifications).where(eq(notifications.organizationId, organizationId));
    await adminDb.delete(notificationRules).where(eq(notificationRules.organizationId, organizationId));
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
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

  const seedSupplierProduct = async (
    adminDb: ReturnType<typeof drizzle<typeof schema>>,
    productId: string,
    supplierSku: string,
    packSize: string | null = '12'
  ) => {
    const supplierProductId = generateId();
    await adminDb.insert(supplierProducts).values({
      id: supplierProductId,
      organizationId,
      supplierId,
      productId,
      supplierSku,
      isConfirmed: true,
      ...(packSize !== null ? { packSize, packUnitId: kgUnitId } : {}),
    });
    return supplierProductId;
  };

  const seedDailyConsumption = async (
    movementService: MovementService,
    productId: string,
    variantId: string,
    days: number,
    dailyAmount: string,
    /** Defaults to the shared describe-block store — every pre-existing caller relies on this. Only the closure-day test below passes its own dedicated store. */
    targetStoreId: string = storeId
  ) => {
    for (let i = 0; i < days; i++) {
      const occurredAt = new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000);
      await movementService.postMovement({
        storeId: targetStoreId,
        productId,
        variantId,
        movementType: 'SALE_CONSUMPTION',
        quantity: `-${dailyAmount}`,
        currency: 'USD',
        occurredAt,
        sourceType: 'TEST',
      });
    }
  };

  it('returns a real suggestion for a low-stock, steadily-consumed, confirmed supplier product', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const { productId, variantId } = await seedProduct(adminDb, 'REORDER-TEST-1');
    await seedSupplierProduct(adminDb, productId, 'SUP-REORDER-1');

    const movementService = new MovementService(createScopedDb(client), organizationId);
    // Real 5kg receipt to establish stock, then steady 1kg/day consumption for 10 days — leaves
    // the product genuinely low on stock relative to its own consumption rate.
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
    await seedDailyConsumption(movementService, productId, variantId, 10, '1');

    const groups = await findReorderSuggestions(createScopedDb(client), organizationId, storeId);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.supplierName).toBe('Test Supplier');
    const row = groups[0]?.suggestions.find((s) => s.productId === productId);
    expect(row).toBeDefined();
    expect(row!.suggestion.quantity.amount.greaterThan(0)).toBe(true);
    expect(row!.explanationText).toMatch(/Suggest/);
    expect(row!.explanationText).toMatch(/lead time is 2 days/);
  });

  it('excludes a supplier product with no consumption history at all (I7 — no fabricated suggestion)', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const { productId } = await seedProduct(adminDb, 'REORDER-TEST-2');
    await seedSupplierProduct(adminDb, productId, 'SUP-REORDER-2');
    // No movements posted at all for this product.

    const groups = await findReorderSuggestions(createScopedDb(client), organizationId, storeId);
    const anyMatch = groups.some((g) => g.suggestions.some((s) => s.productId === productId));
    expect(anyMatch).toBe(false);
  });

  it('excludes a product with no CONFIRMED supplier_products mapping', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const { productId, variantId } = await seedProduct(adminDb, 'REORDER-TEST-3');
    const unconfirmedId = generateId();
    await adminDb.insert(supplierProducts).values({
      id: unconfirmedId,
      organizationId,
      supplierId,
      productId,
      supplierSku: 'SUP-REORDER-3-UNCONFIRMED',
      isConfirmed: false,
    });

    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '1',
      unitCost: '1.00',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      sourceType: 'TEST',
    });
    await seedDailyConsumption(movementService, productId, variantId, 5, '1');

    const groups = await findReorderSuggestions(createScopedDb(client), organizationId, storeId);
    const anyMatch = groups.some((g) => g.suggestions.some((s) => s.productId === productId));
    expect(anyMatch).toBe(false);
  });

  it('a product with abundant stock (way more than lead-time consumption) produces no suggestion', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const { productId, variantId } = await seedProduct(adminDb, 'REORDER-TEST-4');
    await seedSupplierProduct(adminDb, productId, 'SUP-REORDER-4');

    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '10000',
      unitCost: '1.00',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      sourceType: 'TEST',
    });
    await seedDailyConsumption(movementService, productId, variantId, 10, '1');

    const groups = await findReorderSuggestions(createScopedDb(client), organizationId, storeId);
    const anyMatch = groups.some((g) => g.suggestions.some((s) => s.productId === productId));
    expect(anyMatch).toBe(false);
  });

  it('subtracts real on-order quantity from a real SENT purchase order before suggesting', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const { productId, variantId } = await seedProduct(adminDb, 'REORDER-TEST-5');
    const supplierProductId = await seedSupplierProduct(adminDb, productId, 'SUP-REORDER-5', null);

    const movementService = new MovementService(createScopedDb(client), organizationId);
    await movementService.postMovement({
      storeId,
      productId,
      variantId,
      movementType: 'RECEIPT',
      quantity: '5',
      unitCost: '2.00',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      sourceType: 'TEST',
    });
    await seedDailyConsumption(movementService, productId, variantId, 10, '1');

    // A real SENT PO already covers a large on-order quantity for this exact product.
    const poId = generateId();
    await adminDb.insert(purchaseOrders).values({
      id: poId,
      organizationId,
      storeId,
      supplierId,
      poNumber: `PO-REORDER-TEST-${poId}`,
      currency: 'USD',
      status: 'SENT',
    });
    await adminDb.insert(purchaseOrderLines).values({
      id: generateId(),
      organizationId,
      purchaseOrderId: poId,
      supplierProductId,
      productId,
      quantityOrderUnits: '1000',
      conversionToBase: '1',
      quantityBaseUnits: '1000',
      unitPrice: '2.00',
      lineTotal: '2000.0000',
      lineNumber: 1,
    });

    const groups = await findReorderSuggestions(createScopedDb(client), organizationId, storeId);
    const anyMatch = groups.some((g) => g.suggestions.some((s) => s.productId === productId));
    expect(anyMatch).toBe(false);
  });

  it('groups suggestions by supplier', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const secondSupplierId = generateId();
    await adminDb.insert(suppliers).values({
      id: secondSupplierId,
      organizationId,
      name: 'Second Supplier',
      leadTimeDaysContracted: 3,
    });

    const { productId: productA, variantId: variantA } = await seedProduct(adminDb, 'REORDER-TEST-6A');
    await seedSupplierProduct(adminDb, productA, 'SUP-REORDER-6A');
    const { productId: productB, variantId: variantB } = await seedProduct(adminDb, 'REORDER-TEST-6B');
    await adminDb.insert(supplierProducts).values({
      id: generateId(),
      organizationId,
      supplierId: secondSupplierId,
      productId: productB,
      supplierSku: 'SUP-REORDER-6B',
      isConfirmed: true,
    });

    const movementService = new MovementService(createScopedDb(client), organizationId);
    for (const [productId, variantId] of [
      [productA, variantA],
      [productB, variantB],
    ] as const) {
      await movementService.postMovement({
        storeId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '3',
        unitCost: '1.00',
        currency: 'USD',
        occurredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        sourceType: 'TEST',
      });
      await seedDailyConsumption(movementService, productId, variantId, 10, '1');
    }

    const groups = await findReorderSuggestions(createScopedDb(client), organizationId, storeId);
    const supplierNames = groups.map((g) => g.supplierName).sort();
    expect(supplierNames).toEqual(['Second Supplier', 'Test Supplier']);

    await adminDb.delete(supplierProducts).where(eq(supplierProducts.supplierId, secondSupplierId));
    await adminDb.delete(suppliers).where(eq(suppliers.id, secondSupplierId));
  });

  it('a store configured with real operatingHours excludes closure days from the consumption history entirely — never a fabricated zero-consumption reading', async () => {
    const adminDb = drizzle(adminClient, { schema });
    // A dedicated store closed every Sunday, distinct from the shared `storeId` (whose
    // `operatingHours` is unset — open-every-day, the honest default other tests rely on).
    const closedSundayStoreId = generateId();
    await adminDb.insert(stores).values({
      id: closedSundayStoreId,
      organizationId,
      name: 'Sunday-Closed Store',
      timezone: 'UTC',
      operatingHours: [
        { day: 'mon', open: '09:00', close: '18:00' },
        { day: 'tue', open: '09:00', close: '18:00' },
        { day: 'wed', open: '09:00', close: '18:00' },
        { day: 'thu', open: '09:00', close: '18:00' },
        { day: 'fri', open: '09:00', close: '18:00' },
        { day: 'sat', open: '09:00', close: '18:00' },
        // 'sun' deliberately absent — the store is closed Sundays.
      ],
    });

    try {
      const { productId, variantId } = await seedProduct(adminDb, 'REORDER-TEST-CLOSURE');
      await seedSupplierProduct(adminDb, productId, 'SUP-REORDER-CLOSURE');

      const movementService = new MovementService(createScopedDb(client), organizationId);
      await movementService.postMovement({
        storeId: closedSundayStoreId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '5',
        unitCost: '3.00',
        currency: 'USD',
        occurredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        sourceType: 'TEST',
      });
      // Real consumption posted for EVERY calendar day in the last 10 days, Sundays included — a
      // real receiving/POS system could genuinely record a movement on a day the store's own
      // configured schedule says is closed (a late correction, a staff member coming in anyway).
      // The fix under test is that `findReorderSuggestions` treats that Sunday's real movement as
      // a closure day regardless — `isStoreClosedOn` is schedule-derived, not movement-derived.
      await seedDailyConsumption(movementService, productId, variantId, 10, '2', closedSundayStoreId);

      const groups = await findReorderSuggestions(createScopedDb(client), organizationId, closedSundayStoreId);
      const row = groups.flatMap((g) => g.suggestions).find((s) => s.productId === productId);
      expect(row).toBeDefined();
      // The suggestion still resolves — closures don't block a suggestion, they only affect which
      // days count toward the confidence classification and the trimmed-mean input set.
      expect(row!.suggestion.quantity.amount.greaterThan(0)).toBe(true);
    } finally {
      // Child-before-parent: stock_movements/stock_levels reference stores, and the file-level
      // `afterEach` above only ever cleans up rows scoped to the SHARED `storeId`, never this
      // test's own dedicated store.
      await adminDb.delete(stockMovements).where(eq(stockMovements.storeId, closedSundayStoreId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.storeId, closedSundayStoreId));
      await adminDb.delete(stores).where(eq(stores.id, closedSundayStoreId));
    }
  });

  it('a different organization\'s store never sees another org\'s suggestions (I4)', async () => {
    const otherOrgId = generateId();
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.insert(organizations).values({
      id: otherOrgId,
      name: 'Other Org',
      slug: `other-org-reorder-${otherOrgId}`,
      baseCurrency: 'USD',
    });
    const otherStoreId = generateId();
    await adminDb.insert(stores).values({ id: otherStoreId, organizationId: otherOrgId, name: 'Other Store', timezone: 'UTC' });

    const groups = await findReorderSuggestions(createScopedDb(client), otherOrgId, otherStoreId);
    expect(groups).toEqual([]);

    await adminDb.delete(stores).where(eq(stores.organizationId, otherOrgId));
    await adminDb.delete(organizations).where(eq(organizations.id, otherOrgId));
  });
});
