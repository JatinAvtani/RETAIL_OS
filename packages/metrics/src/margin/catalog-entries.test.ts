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
  menuItems,
  organizations,
  outboxEvents,
  posItems,
  products,
  productVariants,
  salesTransactionLines,
  salesTransactions,
  stockLevels,
  stockMovements,
  stores,
  units,
  withTenantContext,
  LotRepository,
  MovementService,
  SalesTransactionRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import type { MarginMetricContext } from './catalog-entries.js';
import './catalog-entries.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * Real-database proof that the registered margin metrics compute correctly through
 * `executeMetric` — the same path `apps/api`'s dashboard router now goes through. Deliberately a
 * DB-backed test rather than a mocked one: the whole point of registering these in a catalog is
 * that a fetch-then-compute metric genuinely reads real rows, not that its plumbing type-checks.
 *
 * Runs as the real `retailos_app` role (not a superuser), so every raw insert/delete against a
 * FORCE-RLS table needs a genuine tenant context — and `stock_movements` specifically has no
 * DELETE grant for this role at all (I3, the append-only ledger), so its cleanup goes through a
 * separate admin connection, matching `below-par.test.ts`'s established convention.
 */
describe('registered margin metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  // No `{ schema }` option needed — the query builder used here (`.delete().where()`) doesn't
  // require Drizzle's relational-query schema registration, only the plain table objects.
  const adminDb = drizzle(adminClient);
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      // lots and stock_levels both reference product_variants — must go before it's deleted below.
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      // sales_transaction_lines references pos_items, and pos_items references menu_items —
      // both must go after the lines above and before stores/organizations below.
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(menuItems).where(eq(menuItems.organizationId, orgId));
      const orgProducts = await adminDb
        .select({ id: products.id })
        .from(products)
        .where(eq(products.organizationId, orgId));
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
      name: `Catalog Test Org ${organizationId}`,
      slug: `catalog-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    // `stores` is FORCE-RLS; a one-off raw insert still needs a real tenant context under the
    // app role.
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' })
      )
    );
    return { organizationId, storeId };
  };

  const auth = (permissions: readonly string[] = ['financial:read']): AuthContext => ({
    userId: 'u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const ctxFor = (organizationId: string): MarginMetricContext => ({
    db,
    organizationId,
    storeIds: 'ALL',
    resolveRecipeUnitCost: async () => 'unknown',
  });

  it('net_revenue sums real sales lines in the period', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `CAT-A-${organizationId}`,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      subtotal: '30.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '30.0000',
      currency: 'USD',
      lines: [{ quantity: '1.000000', unitPrice: '30.0000', discount: '0.0000', lineTotal: '30.0000' }],
    });

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const result = await executeMetric(
      'net_revenue',
      { storeId, from, to },
      auth(),
      ctxFor(organizationId)
    );

    expect(result.value).toBe('30.0000');
    expect(result.unit).toBe('CURRENCY');
    expect(result.provenance[0]?.table).toBe('sales_transaction_lines');
  });

  it('cogs_actual is unknown when a consumed lot has no recorded cost — never a fabricated zero', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `CAT-U-${productId}`,
          name: 'Uncosted',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
        });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );

    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        tx.insert(stockMovements).values({
          id: generateId(),
          organizationId,
          storeId,
          productId,
          variantId,
          movementType: 'SALE_CONSUMPTION',
          quantity: '-3.000000',
          unitCost: null,
          currency: 'USD',
          occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          recordedAt: new Date(),
          sourceType: 'test',
        })
      )
    );

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const result = await executeMetric(
      'cogs_actual',
      { storeId, from, to },
      auth(),
      ctxFor(organizationId)
    );

    expect(result.value).toBe('unknown');
    expect(result.unknownReason).toBeDefined();
  });

  it('cogs_actual and contribution_margin agree with a hand-derived figure from real lots and consumption', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    const variantId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(products).values({
          id: productId,
          organizationId,
          sku: `CAT-C-${productId}`,
          name: 'Costed',
          baseUnitId: eachUnit!.id,
          type: 'INGREDIENT',
        });
        await tx.insert(productVariants).values({ id: variantId, productId, name: 'Default', isDefault: true });
      })
    );

    const lotRepo = new LotRepository(db, organizationId);
    const lot = await lotRepo.receive({
      id: generateId(),
      storeId,
      productId,
      variantId,
      receivedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      initialQuantity: '50.000000',
      unitCost: '3.0000',
      currency: 'USD',
    });
    const movements = new MovementService(db, organizationId);
    // 4 units consumed at $3.00 each = $12.00 actual COGS.
    await movements.postMovement({
      storeId,
      productId,
      variantId,
      lotId: lot.id,
      movementType: 'SALE_CONSUMPTION',
      quantity: '-4.000000',
      unitCost: '3.0000',
      currency: 'USD',
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      sourceType: 'test',
    });

    // The sold line must come from a MAPPED POS item: the population-mismatch gate (correctly)
    // refuses to compare COGS against revenue while any sold line is unmapped, so a fixture whose
    // line has no POS item at all would make every ratio here 'unknown' — an earlier version of
    // this fixture did exactly that, which was this test quietly embodying the same
    // revenue-without-cost mismatch the gate now exists to catch.
    const menuItemId = generateId();
    const posItemId = generateId();
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await tx.insert(menuItems).values({
          id: menuItemId,
          organizationId,
          name: 'Costed Plate',
          recipeGroupId: generateId(),
          price: '40.0000',
          priceValidFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        });
        await tx.insert(posItems).values({
          id: posItemId,
          organizationId,
          storeId,
          source: 'square',
          externalId: `CAT-C-POS-${organizationId}`,
          name: 'Costed Plate',
          menuItemId,
          mappingStatus: 'MAPPED',
        });
      })
    );

    const salesRepo = new SalesTransactionRepository(db, organizationId);
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `CAT-C-SALE-${organizationId}`,
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      subtotal: '40.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '40.0000',
      currency: 'USD',
      lines: [{ posItemId, quantity: '1.000000', unitPrice: '40.0000', discount: '0.0000', lineTotal: '40.0000' }],
    });

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const params = { storeId, from, to };
    const ctx = ctxFor(organizationId);

    const [cogsActual, contributionMargin, foodCostPercentage] = await Promise.all([
      executeMetric('cogs_actual', params, auth(), ctx),
      executeMetric('contribution_margin', params, auth(), ctx),
      executeMetric('food_cost_percentage', params, auth(), ctx),
    ]);

    expect(cogsActual.value).toBe('12.0000');
    // 40 - 12 = 28.
    expect(contributionMargin.value).toBe('28.0000');
    // 12 / 40 = 30%.
    expect(foodCostPercentage.value).toBe('30.00');
  });

  it('an unmapped sold line makes every cost-vs-revenue metric unknown — never a confident ratio over mismatched populations', async () => {
    const { organizationId, storeId } = await setUpOrg();

    // One real sold line with NO POS item at all — quarantined revenue with no possible
    // consumption or recipe cost behind it. Revenue counts it (that is real money the till took);
    // any metric comparing a cost against that revenue must refuse, because the cost side
    // structurally excludes this line and the resulting ratio would overstate margin.
    const salesRepo = new SalesTransactionRepository(db, organizationId);
    await salesRepo.recordIfNew({
      storeId,
      source: 'square',
      externalId: `CAT-G-SALE-${organizationId}`,
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      subtotal: '25.0000',
      discount: '0.0000',
      tax: '0.0000',
      total: '25.0000',
      currency: 'USD',
      lines: [{ quantity: '1.000000', unitPrice: '25.0000', discount: '0.0000', lineTotal: '25.0000' }],
    });

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const params = { storeId, from, to };
    const ctx = ctxFor(organizationId);

    const [netRevenue, contributionMargin, contributionMarginPct, foodCostPercentage, cogsTheoretical, costVariance] =
      await Promise.all([
        executeMetric('net_revenue', params, auth(), ctx),
        executeMetric('contribution_margin', params, auth(), ctx),
        executeMetric('contribution_margin_percentage', params, auth(), ctx),
        executeMetric('food_cost_percentage', params, auth(), ctx),
        executeMetric('cogs_theoretical', params, auth(), ctx),
        executeMetric('cost_variance', params, auth(), ctx),
      ]);

    // Revenue itself stays real — an unmapped sale is still a sale, deliberately ungated.
    expect(netRevenue.value).toBe('25.0000');

    for (const result of [contributionMargin, contributionMarginPct, foodCostPercentage, cogsTheoretical, costVariance]) {
      expect(result.value).toBe('unknown');
      expect(result.unknownReason).toContain('1 sold line(s)');
      expect(result.unknownReason).toContain('no mapped menu item');
    }
  });

  it('executeMetric refuses a caller without financial:read for any margin metric', async () => {
    const { organizationId, storeId } = await setUpOrg();
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

    await expect(
      executeMetric('net_revenue', { storeId, from, to }, auth([]), ctxFor(organizationId))
    ).rejects.toThrow(/financial:read/);
  });
});
