import { describe, expect, it, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '@retailos/authz';
import {
  auditLogs,
  createDb,
  documents,
  lots,
  menuItems,
  organizations,
  outboxEvents,
  posItems,
  products,
  productVariants,
  recipeComponents,
  recipes,
  salesTransactionLines,
  salesTransactions,
  stockLevels,
  stockMovements,
  stores,
  suppliers,
  supplierProducts,
  supplierPrices,
  MenuItemRepository,
} from '@retailos/db';
import { executeMetric } from '../catalog/index.js';
import type { MarginMetricContext } from '../margin/catalog-entries.js';
import '../margin/catalog-entries.js';
import '../sales/catalog-entries.js';
import '../waste/catalog-entries.js';
import '../inventory/catalog-entries.js';
import '../documents/catalog-entries.js';
import '../cost/catalog-entries.js';
import { seedGoldenFixture, type GoldenFixture } from './fixture.js';
import { resolveGoldenRecipeUnitCost } from './resolver.js';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

/**
 * The golden regression harness (the design). A representative cross-section of
 * registered metrics — spanning sales, cost, margin, inventory, waste, and documents — asserted
 * against ONE shared, hand-derived fixture (confirmed with the user over all 60 registered
 * metrics, which would be disproportionate effort for a portfolio-scoped task). If any of these
 * values ever changes, that's a real, reviewable signal: either a genuine, intentional formula
 * change (update this file's own expected values AND explain why in the commit), or a real
 * regression (fix the code, not the test).
 *
 * One shared `beforeAll`-seeded fixture, not per-test seeding — the whole point of a golden
 * fixture is that every metric here is asserted against the EXACT SAME real data, so a change that
 * breaks one metric's number but not another's is immediately visible as an inconsistency, not
 * hidden behind N independently-tuned fixtures.
 */
describe('golden regression — a representative cross-section of registered metrics', () => {
  const db = createDb(APP_CONNECTION_STRING).db;
  const adminClient = postgres(ADMIN_CONNECTION_STRING);
  const adminDb = drizzle(adminClient);

  let fixture: GoldenFixture;

  const auth = (permissions: readonly string[]): AuthContext => ({
    userId: 'golden-u1',
    organizationId: 'org-placeholder',
    storeIds: 'ALL',
    role: 'OWNER',
    permissions: new Set(permissions) as AuthContext['permissions'],
  });

  const ALL_PERMISSIONS = ['financial:read', 'inventory:read', 'documents:read', 'purchasing:read'];

  // `resolveRecipeUnitCost`'s real production wiring (`apps/api`'s `dashboard.ts`) is called with a
  // MENU ITEM id, not a recipe group id directly — it looks up the menu item first, THEN resolves
  // its `recipeGroupId`, before calling the low-level cost resolver. The parameter is genuinely
  // named `menuItemId` at every real call site despite the type's own parameter name; skipping this
  // translation is exactly the "menuItemId passed where recipeGroupId was expected" bug class this
  // project's own memory already flags from earlier work — reproduced here on the first draft, caught by
  // this harness itself before being trusted.
  const marginCtx = (organizationId: string): MarginMetricContext => ({
    db,
    organizationId,
    storeIds: 'ALL',
    resolveRecipeUnitCost: async (ctx, menuItemId, currency) => {
      const menuItemRepository = new MenuItemRepository(ctx.db, ctx.organizationId);
      const menuItem = await menuItemRepository.findById(menuItemId);
      if (!menuItem) return 'unknown';
      return resolveGoldenRecipeUnitCost(ctx.db, ctx.organizationId, menuItem.recipeGroupId, currency);
    },
  });

  const plainCtx = (organizationId: string) => ({ db, organizationId, storeIds: 'ALL' as const });

  // Seeded once, real setup that takes real time — every `it` below reads the SAME fixture rather
  // than each paying seed cost again, matching a shared-fixture harness's whole point.
  const setup = (async () => {
    fixture = await seedGoldenFixture(db);
  })();

  afterAll(async () => {
    await setup;
    const orgId = fixture.organizationId;
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
    await adminDb.delete(documents).where(eq(documents.organizationId, orgId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
    await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
    await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
    await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
    await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
    await adminDb.delete(menuItems).where(eq(menuItems.organizationId, orgId));
    const orgRecipes = await adminDb.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
    for (const r of orgRecipes) {
      await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
    }
    await adminDb.delete(recipes).where(eq(recipes.organizationId, orgId));
    const orgSupplierProducts = await adminDb.select({ id: supplierProducts.id }).from(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
    for (const sp of orgSupplierProducts) {
      await adminDb.delete(supplierPrices).where(eq(supplierPrices.supplierProductId, sp.id));
    }
    await adminDb.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, orgId));
    const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
    for (const p of orgProducts) {
      await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
    }
    await adminDb.delete(products).where(eq(products.organizationId, orgId));
    await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
    await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    await adminClient.end();
  });

  const period = () => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from, to };
  };

  it('gross_revenue = $60.00 + $40.00 = $100.00 — both completed transactions\' subtotal', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('gross_revenue', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('100.0000');
  });

  it('net_revenue = $100.00 — no discounts, no refunds in the fixture', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('net_revenue', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('100.0000');
  });

  it('transaction_count = 2 — two real completed transactions', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('transaction_count', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('2');
  });

  it('units_sold = 10 — 6 + 4 units across the two transactions', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('units_sold', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('10.000000');
  });

  it('cogs_actual = $20.00 — 10 real units consumed at $2.00 real actual unit cost', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('cogs_actual', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('20.0000');
  });

  it('cogs_theoretical = $20.00 — 10 units sold x $2.00 real recipe unit cost ($20/10-pack -> $2/each)', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('cogs_theoretical', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('20.0000');
  });

  it('cost_variance = $0.00 — actual and theoretical COGS agree exactly in this fixture', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('cost_variance', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('0.0000');
  });

  it('contribution_margin = $80.00 — $100.00 net revenue minus $20.00 actual COGS', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('contribution_margin', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('80.0000');
  });

  it('food_cost_percentage = 20.00% — $20.00 actual COGS / $100.00 net revenue', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('food_cost_percentage', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('20.00'); // this metric formats to 2 decimal places, not 4 — confirmed against the real code, not assumed
  });

  it('waste_value = $4.00 — 2 real wasted units at $2.00 real cost', async () => {
    await setup;
    const { from, to } = period();
    const result = await executeMetric('waste_value', { storeId: fixture.storeId, from, to }, auth(ALL_PERMISSIONS), marginCtx(fixture.organizationId));
    expect(result.value).toBe('4.0000');
  });

  it('stock_on_hand = 88.000000 — 100 received minus 10 consumed minus 2 wasted', async () => {
    await setup;
    const result = await executeMetric(
      'stock_on_hand',
      { storeId: fixture.storeId, productId: fixture.productId, variantId: fixture.variantId },
      auth(ALL_PERMISSIONS),
      plainCtx(fixture.organizationId)
    );
    expect(result.value).toBe('88.000000');
  });

  it('stock_value = $176.00 — 88 units on hand x $2.00 real average unit cost', async () => {
    await setup;
    const result = await executeMetric('stock_value', { storeId: fixture.storeId }, auth(ALL_PERMISSIONS), plainCtx(fixture.organizationId));
    expect(result.value).toBe('176.0000');
  });

  it('unit_cost_weighted_avg = $2.00 — a single receipt at a single known cost', async () => {
    await setup;
    const result = await executeMetric(
      'unit_cost_weighted_avg',
      { storeId: fixture.storeId, productId: fixture.productId, variantId: fixture.variantId },
      auth(ALL_PERMISSIONS),
      plainCtx(fixture.organizationId)
    );
    expect(result.value).toBe('2.0000');
  });

  it('documents_pending_review = 1 — one real document at REVIEW_REQUIRED', async () => {
    await setup;
    const result = await executeMetric('documents_pending_review', { storeId: fixture.storeId }, auth(ALL_PERMISSIONS), plainCtx(fixture.organizationId));
    expect(result.value).toBe('1');
  });
});
