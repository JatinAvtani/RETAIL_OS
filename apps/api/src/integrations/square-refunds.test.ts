import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  organizations,
  posConnections,
  posItems,
  salesTransactionLines,
  salesTransactions,
  outboxEvents,
  auditLogs,
  stockMovements,
  stockLevels,
  lots,
  products,
  productVariants,
  recipes,
  recipeComponents,
  menuItems,
  categories,
  stores,
  units,
  ProductRepository,
  RecipeRepository,
  MenuItemRepository,
  LotRepository,
} from '@retailos/db';
import { encryptToken } from '@retailos/pos';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../server';
import type { FastifyInstance } from 'fastify';

/**
 * 006-08 (plan.md's own named "subtle part"): end-to-end proof that a refund (1) records a
 * REFUNDED transaction linked to the original, (2) reduces net revenue, and (3) REVERSES the
 * corresponding consumption — the three explicit acceptance criteria, exercised together through
 * the real HTTP surface rather than unit-tested in isolation. Builds a real product -> recipe ->
 * menu item chain (same fixture shape `sales-ingestion-pipeline.test.ts` already established) with
 * a real lot, syncs a COMPLETED order for it (posting real consumption via 006-12's new wiring),
 * then syncs the same order again with a refund attached and proves the reversal.
 */
describe('Square refund handling — full consumption reversal, end to end', () => {
  let app: FastifyInstance;
  let originalEnv: Record<string, string | undefined>;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sessionStore = new SessionStore(redis);
  const createdOrgIds: string[] = [];
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    originalEnv = {
      SQUARE_APPLICATION_ID: process.env.SQUARE_APPLICATION_ID,
      SQUARE_APPLICATION_SECRET: process.env.SQUARE_APPLICATION_SECRET,
      SQUARE_REDIRECT_URI: process.env.SQUARE_REDIRECT_URI,
      SQUARE_ENVIRONMENT: process.env.SQUARE_ENVIRONMENT,
      POS_TOKEN_ENCRYPTION_KEY: process.env.POS_TOKEN_ENCRYPTION_KEY,
    };
    process.env.SQUARE_APPLICATION_ID = 'test-square-app-id';
    process.env.SQUARE_APPLICATION_SECRET = 'test-square-app-secret';
    process.env.SQUARE_REDIRECT_URI = 'http://localhost:3001/integrations/square/callback';
    process.env.SQUARE_ENVIRONMENT = 'sandbox';
    process.env.POS_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-for-refunds-test';

    app = buildServer({ logger: false });
    await app.ready();
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const orgId of createdOrgIds) {
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await db.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await db.delete(lots).where(eq(lots.organizationId, orgId));
      await db.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await db.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await db.delete(posItems).where(eq(posItems.organizationId, orgId));
      await db.delete(posConnections).where(eq(posConnections.organizationId, orgId));
      await db.delete(menuItems).where(eq(menuItems.organizationId, orgId));
      const orgRecipes = await db.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await db.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await db.delete(recipes).where(eq(recipes.organizationId, orgId));
      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(categories).where(eq(categories.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A real product -> recipe -> menu item chain, a real lot with stock, and a real pos_items row mapped to the menu item — everything triggerConsumptionForTransaction needs to post genuine consumption, not a quarantine. */
  const setUpMappedMenuItemWithStock = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Refund Test Org ${organizationId}`,
      slug: `refund-test-org-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const [gramUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'g'));
    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    if (!gramUnit || !eachUnit) throw new Error('seeded units g/each not found — migrations not applied?');

    const productRepo = new ProductRepository(db, organizationId);
    const flour = await productRepo.create({
      id: generateId(),
      sku: `FLOUR-${generateId()}`,
      name: 'Flour',
      baseUnitId: gramUnit.id,
      type: 'INGREDIENT',
    });
    const flourVariantId = (await productRepo.findVariants(flour.id))[0]!.id;

    const recipeRepo = new RecipeRepository(db, organizationId);
    const recipeGroupId = generateId();
    await recipeRepo.create({
      id: generateId(),
      recipeGroupId,
      name: 'Simple Bun',
      yieldQuantity: '1',
      yieldUnitId: eachUnit.id,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ componentType: 'PRODUCT', productId: flour.id, quantity: '40', unitId: gramUnit.id }],
    });

    const menuItemRepo = new MenuItemRepository(db, organizationId);
    const menuItem = await menuItemRepo.create({
      id: generateId(),
      name: 'Simple Bun',
      recipeGroupId,
      price: '4.50',
      priceValidFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const lotRepo = new LotRepository(db, organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId,
      productId: flour.id,
      variantId: flourVariantId,
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      initialQuantity: '1000.000000',
      unitCost: '0.0020',
      currency: 'USD',
    });

    const merchantId = `refund-test-merchant-${organizationId}`;
    await db.insert(posConnections).values({
      id: generateId(),
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: merchantId,
      externalLocationId: 'LOC-1',
      accessTokenCiphertext: encryptToken('fake-access-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
      refreshTokenCiphertext: encryptToken('fake-refresh-token', process.env.POS_TOKEN_ENCRYPTION_KEY),
      status: 'CONNECTED',
    });

    await db.insert(posItems).values({
      id: generateId(),
      organizationId,
      storeId,
      source: 'square',
      externalId: 'VAR-BUN-1',
      name: 'Simple Bun',
      menuItemId: menuItem.id,
      mappingStatus: 'MAPPED',
    });

    return { organizationId, storeId };
  };

  const issueSession = async (organizationId: string): Promise<string> => {
    const { token } = await sessionStore.create(
      { userId: generateId(), organizationId, storeIds: 'ALL', role: 'OWNER', permissions: [] },
      '127.0.0.1',
      'test-agent'
    );
    return token;
  };

  const orderWire = (externalId: string, refunds?: Array<{ amount_money: { amount: number; currency: string }; status: string }>) => ({
    id: externalId,
    location_id: 'LOC-1',
    created_at: '2026-08-02T12:00:00Z',
    updated_at: '2026-08-02T12:00:00Z',
    state: 'COMPLETED',
    line_items: [
      {
        uid: `${externalId}-LINE-1`,
        catalog_object_id: 'VAR-BUN-1',
        name: 'Simple Bun',
        quantity: '1',
        base_price_money: { amount: 450, currency: 'USD' },
        total_money: { amount: 450, currency: 'USD' },
      },
    ],
    total_money: { amount: 450, currency: 'USD' },
    total_tax_money: { amount: 0, currency: 'USD' },
    total_discount_money: { amount: 0, currency: 'USD' },
    ...(refunds !== undefined ? { refunds } : {}),
  });

  const stubSquareOrdersInSequence = (pages: unknown[]): void => {
    let call = 0;
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v2/orders/search')) {
        const body = pages[Math.min(call, pages.length - 1)];
        call += 1;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch;
  };

  it('a genuinely mapped order posts real consumption via the recipe, not a quarantine', async () => {
    const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
    const sessionCookie = await issueSession(organizationId);
    stubSquareOrdersInSequence([{ orders: [orderWire('ORDER-CONSUME-1')] }]);

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(response.statusCode).toBe(200);

    const movementRows = await db.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    expect(movementRows).toHaveLength(1);
    expect(movementRows[0]!.movementType).toBe('SALE_CONSUMPTION');
    expect(movementRows[0]!.quantity).toBe('-40.000000'); // 1 bun * 40g flour per the recipe

    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(movementRows[0]!.sourceId).toBe(txRows[0]!.id); // traceable back to the real originating sale
  });

  it('a full refund on a previously-synced order records a REFUNDED transaction linked via refundOfId and fully reverses consumption', async () => {
    const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
    const sessionCookie = await issueSession(organizationId);
    const orderId = 'ORDER-FULL-REFUND-1';

    // First sync: the sale happens, real consumption posts.
    stubSquareOrdersInSequence([{ orders: [orderWire(orderId)] }]);
    const first = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(first.statusCode).toBe(200);

    const originalTxRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(originalTxRows).toHaveLength(1);
    const originalTx = originalTxRows[0]!;

    // Second sync: Square now reports a full APPROVED refund on the SAME order.
    stubSquareOrdersInSequence([{ orders: [orderWire(orderId, [{ amount_money: { amount: 450, currency: 'USD' }, status: 'APPROVED' }])] }]);
    const second = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body).result.data;
    expect(secondBody.refundsProcessed).toBe(1);

    const allTxRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(allTxRows).toHaveLength(2); // the original COMPLETED row, plus a new REFUNDED row
    const refundRow = allTxRows.find((r) => r.status === 'REFUNDED');
    expect(refundRow).toBeDefined();
    expect(refundRow!.refundOfId).toBe(originalTx.id);
    expect(refundRow!.total).toBe('4.5000'); // the full refunded amount

    const movementRows = await db.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    expect(movementRows).toHaveLength(2); // the original consumption + its reversal
    const reversal = movementRows.find((m) => m.movementType === 'SALE_REVERSAL');
    expect(reversal).toBeDefined();
    expect(reversal!.quantity).toBe('40.000000'); // the FULL 40g flour returned — a 100% refund
  });

  it('a partial refund reverses consumption proportionally, not fully', async () => {
    const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
    const sessionCookie = await issueSession(organizationId);
    const orderId = 'ORDER-PARTIAL-REFUND-1';

    stubSquareOrdersInSequence([{ orders: [orderWire(orderId)] }]);
    await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    // Refund exactly half the order total ($2.25 of $4.50).
    stubSquareOrdersInSequence([{ orders: [orderWire(orderId, [{ amount_money: { amount: 225, currency: 'USD' }, status: 'APPROVED' }])] }]);
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(response.statusCode).toBe(200);

    const refundRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    const refundRow = refundRows.find((r) => r.status === 'REFUNDED');
    expect(refundRow!.total).toBe('2.2500');

    const movementRows = await db.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    const reversal = movementRows.find((m) => m.movementType === 'SALE_REVERSAL');
    expect(reversal!.quantity).toBe('20.000000'); // 50% of the original 40g consumed — proportional, not full
  });

  it('a SECOND, later partial refund on the same order reverses only the INCREMENTAL amount, not a second full reversal', async () => {
    const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
    const sessionCookie = await issueSession(organizationId);
    const orderId = 'ORDER-STAGED-REFUND-1';

    stubSquareOrdersInSequence([{ orders: [orderWire(orderId)] }]);
    await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    // First partial refund: $2.25 of $4.50 (50%).
    stubSquareOrdersInSequence([{ orders: [orderWire(orderId, [{ amount_money: { amount: 225, currency: 'USD' }, status: 'APPROVED' }])] }]);
    await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });

    // A LATER sync sees the SAME order now fully refunded ($4.50 of $4.50) — the merchant issued a
    // second partial refund for the remaining half.
    stubSquareOrdersInSequence([{ orders: [orderWire(orderId, [{ amount_money: { amount: 450, currency: 'USD' }, status: 'APPROVED' }])] }]);
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(response.statusCode).toBe(200);

    const refundRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    const refundRowsOnly = refundRows.filter((r) => r.status === 'REFUNDED');
    expect(refundRowsOnly).toHaveLength(1); // updated in place, not a second row
    expect(refundRowsOnly[0]!.total).toBe('4.5000'); // now reflects the full refunded total

    const movementRows = await db.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    const reversals = movementRows.filter((m) => m.movementType === 'SALE_REVERSAL');
    expect(reversals).toHaveLength(2); // one for each incremental refund
    const totalReversed = reversals.reduce((sum, m) => sum + Number(m.quantity), 0);
    expect(totalReversed).toBe(40); // 20g (first 50%) + 20g (second 50%) = the full 40g, exactly once
  });

  it('a CANCELED order (a void) posts NO consumption and reduces to zero revenue — it never generated consumption to reverse', async () => {
    const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
    const sessionCookie = await issueSession(organizationId);
    stubSquareOrdersInSequence([
      {
        orders: [
          {
            id: 'ORDER-VOID-1',
            location_id: 'LOC-1',
            created_at: '2026-08-02T12:00:00Z',
            state: 'CANCELED',
            line_items: [],
            total_money: { amount: 0, currency: 'USD' },
          },
        ],
      },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/integrations.syncSquareOrders',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(response.statusCode).toBe(200);

    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
    expect(txRows[0]!.status).toBe('VOIDED');

    const movementRows = await db.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    expect(movementRows).toHaveLength(0); // a void never generated consumption in the first place
  });
});
