import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  organizations,
  posConnections,
  posItems,
  salesTransactionLines,
  salesTransactions,
  outboxEvents,
  stores,
  unmappedSales,
  stockMovements,
  stockLevels,
  lots,
  auditLogs,
  products,
  productVariants,
  recipes,
  recipeComponents,
  menuItems,
  categories,
  units,
  ProductRepository,
  RecipeRepository,
  MenuItemRepository,
  LotRepository,
} from '@retailos/db';
import { encryptToken, type SquareOAuthConfig } from '@retailos/pos';
import { generateId } from '@retailos/domain';
import { syncSquareOrders, reconcileSquareOrders, SquareNotConnectedError, SquareLocationMissingError } from './square-orders-sync';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

const ENCRYPTION_KEY = 'test-encryption-key-for-integrations-orders-package';

const squareConfig: SquareOAuthConfig = {
  applicationId: 'sq0idp-test-app-id',
  applicationSecret: 'sq0csp-test-secret',
  redirectUri: 'http://localhost:3001/integrations/square/callback',
  environment: 'sandbox',
};

/**
 * Real Postgres verification for `syncSquareOrders` and `reconcileSquareOrders`, called DIRECTLY
 * (no router, no HTTP, no session) — moved out of
 * `apps/api/src/trpc/routers/integrations-orders.test.ts` and `integrations-reconcile.test.ts` when
 * both functions relocated to this package so `apps/worker`'s job processor could call the
 * identical code. `global.fetch` is patched (Square's own host only) — no live Square sandbox app
 * exists in this codebase, same standing limitation as the original router tests. This file
 * specifically proves the plan's named top risk: the cursor and watermark only advance together
 * with the order/line writes they gate, a re-synced (overlapping) window is genuinely idempotent,
 * and reconciliation finds gaps the incremental sync's own watermark would never revisit while
 * never perturbing that watermark itself.
 */
describe('syncSquareOrders / reconcileSquareOrders', () => {
  const { db: appDb, client: appClient } = createDb(APP_CONNECTION_STRING);
  const { db: adminDb, client: adminClient } = createDb(ADMIN_CONNECTION_STRING);
  const createdOrgIds: string[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const orgId of createdOrgIds) {
      // syncSquareOrders genuinely triggers consumption for each recorded line — unmapped_sales (a
      // real menu-item quarantine) and stock_movements/stock_levels/lots (a real FEFO consumption)
      // are all real write paths, not hypothetical ones, and each needs its own cleanup before
      // stores/organizations can be deleted.
      await adminDb.delete(unmappedSales).where(eq(unmappedSales.organizationId, orgId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
      await adminDb.delete(posConnections).where(eq(posConnections.organizationId, orgId));
      await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
      await adminDb.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await appClient.end();
    await adminClient.end();
  });

  const setUpOrgWithStore = async (): Promise<{ organizationId: string; storeId: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: `Square Orders Sync Test Org ${organizationId}`,
      slug: `square-orders-sync-test-org-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const connectSquare = async (organizationId: string, storeId: string, externalLocationId: string | null = 'LOC-1'): Promise<void> => {
    await adminDb.insert(posConnections).values({
      id: generateId(),
      organizationId,
      storeId,
      vendor: 'square',
      externalAccountId: 'test-merchant',
      externalLocationId,
      accessTokenCiphertext: encryptToken('fake-access-token', ENCRYPTION_KEY),
      refreshTokenCiphertext: encryptToken('fake-refresh-token', ENCRYPTION_KEY),
      status: 'CONNECTED',
    });
  };

  const stubSquareOrdersResponse = (body: unknown): void => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v2/orders/search')) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    }) as typeof fetch;
  };

  /** Multiple sequential pages, one page per call — proves cursor-driven pagination genuinely
   * drains, not just a single-page happy path. */
  const stubSquareOrdersResponsesInSequence = (pages: unknown[]): void => {
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

  const oneCompletedOrder = (externalId: string, catalogObjectId = 'VAR-1') => ({
    orders: [orderWire(externalId, catalogObjectId)],
  });

  /** Same order shape as `oneCompletedOrder`, but exposed as a single order object (not wrapped in
   * `{ orders: [...] }`) so a refund array can be attached — matches the real Square wire shape
   * `refunds` lives on. */
  const orderWire = (externalId: string, catalogObjectId = 'VAR-1', refunds?: Array<{ amount_money: { amount: number; currency: string }; status: string }>) => ({
    id: externalId,
    location_id: 'LOC-1',
    created_at: '2026-08-02T12:00:00Z',
    updated_at: '2026-08-02T12:00:00Z',
    state: 'COMPLETED',
    line_items: [
      {
        uid: `${externalId}-LINE-1`,
        catalog_object_id: catalogObjectId,
        name: 'Cappuccino',
        quantity: '1',
        base_price_money: { amount: 450, currency: 'USD' },
        total_money: { amount: 450, currency: 'USD' },
      },
    ],
    total_money: { amount: 450, currency: 'USD' },
    total_tax_money: { amount: 36, currency: 'USD' },
    total_discount_money: { amount: 0, currency: 'USD' },
    ...(refunds !== undefined ? { refunds } : {}),
  });

  describe('syncSquareOrders', () => {
    it('throws SquareNotConnectedError for a store with no Square connection', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await expect(syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY)).rejects.toThrow(
        SquareNotConnectedError
      );
    });

    it('throws SquareLocationMissingError for a connection with no linked externalLocationId', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId, null);
      await expect(syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY)).rejects.toThrow(
        SquareLocationMissingError
      );
    });

    it('a genuinely connected store syncs a real order into sales_transactions + lines + an outbox event, all in one commit', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);
      await adminDb.insert(posItems).values({
        id: generateId(),
        organizationId,
        storeId,
        source: 'square',
        externalId: 'VAR-1',
        name: 'Cappuccino',
        mappingStatus: 'UNMAPPED',
      });

      stubSquareOrdersResponse(oneCompletedOrder('ORDER-SYNC-1'));

      const result = await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(result.transactionsRecorded).toBe(1);
      expect(result.transactionsDuplicate).toBe(0);

      const txRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(txRows).toHaveLength(1);
      expect(txRows[0]!.externalId).toBe('ORDER-SYNC-1');
      expect(txRows[0]!.status).toBe('COMPLETED');
      expect(txRows[0]!.total).toBe('4.5000');

      const lineRows = await adminDb.select().from(salesTransactionLines).where(eq(salesTransactionLines.organizationId, organizationId));
      expect(lineRows).toHaveLength(1);
      expect(lineRows[0]!.posItemId).not.toBeNull(); // resolved via catalog_object_id -> pos_items.external_id

      const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]!.eventType).toBe('sales.ingested');

      const connectionRows = await adminDb.select().from(posConnections).where(eq(posConnections.organizationId, organizationId));
      expect(connectionRows[0]!.ordersSyncWatermark).not.toBeNull();
    });

    it('a line whose catalog_object_id has no matching pos_items row still records the transaction, with posItemId null', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);

      stubSquareOrdersResponse(oneCompletedOrder('ORDER-UNKNOWN-ITEM', 'VAR-NEVER-SYNCED'));

      const result = await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(result.transactionsRecorded).toBe(1);

      const lineRows = await adminDb.select().from(salesTransactionLines).where(eq(salesTransactionLines.organizationId, organizationId));
      expect(lineRows).toHaveLength(1);
      expect(lineRows[0]!.posItemId).toBeNull();
    });

    it('re-syncing the same order (an overlapping window) is idempotent — recorded once, counted duplicate the second time', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);

      stubSquareOrdersResponse(oneCompletedOrder('ORDER-IDEMPOTENT'));
      const first = await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(first.transactionsRecorded).toBe(1);

      stubSquareOrdersResponse(oneCompletedOrder('ORDER-IDEMPOTENT'));
      const second = await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(second.transactionsRecorded).toBe(0);
      expect(second.transactionsDuplicate).toBe(1);

      const txRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(txRows).toHaveLength(1); // no duplicate row, no double-counted revenue

      const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
      expect(outboxRows).toHaveLength(1); // no duplicate event for the duplicate sync
    });

    it('a multi-page backfill whose SECOND page overlaps orders the FIRST page already ingested is still exactly-once', async () => {
      // The plan's own named risk applied across pages within a SINGLE sync run, not just across
      // two separate calls: a vendor-side window overlap, or a retried page after a transient
      // failure, must not double-record the order that appears on both pages.
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);

      stubSquareOrdersResponsesInSequence([
        { orders: [orderWire('BACKFILL-A'), orderWire('BACKFILL-B')], cursor: 'page-2-cursor' },
        { orders: [orderWire('BACKFILL-B'), orderWire('BACKFILL-C')] },
      ]);

      const result = await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(result.transactionsRecorded).toBe(3); // A, B, C each recorded exactly once
      expect(result.transactionsDuplicate).toBe(1); // B's second appearance

      const txRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(txRows).toHaveLength(3);
      expect(txRows.map((r) => r.externalId).sort()).toEqual(['BACKFILL-A', 'BACKFILL-B', 'BACKFILL-C']);
    });

    it('two independent calls converging on the same order (e.g. a webhook-triggered sync followed by a manual sync) record it exactly once', async () => {
      // Real-world shape this proves: the webhook route and the manual "sync now" trigger both
      // enqueue the SAME job type onto SQUARE_SYNC_QUEUE_NAME now (square-sync-queue.ts) — this is
      // the actual cross-path convergence point post-refactor. Calling syncSquareOrders twice
      // proves the underlying idempotency the queue relies on, regardless of which caller enqueued
      // which run.
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);
      const orderId = 'CROSS-PATH-ORDER-1';

      stubSquareOrdersResponse(oneCompletedOrder(orderId));
      const first = await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(first.transactionsRecorded).toBe(1);

      stubSquareOrdersResponse(oneCompletedOrder(orderId));
      const second = await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(second.transactionsRecorded).toBe(0);
      expect(second.transactionsDuplicate).toBe(1);

      const txRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(txRows).toHaveLength(1);
      const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
      expect(outboxRows).toHaveLength(1);
    });

    it('a CANCELED order maps to sales_transactions.status VOIDED', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);

      stubSquareOrdersResponse({
        orders: [
          {
            id: 'ORDER-CANCELED',
            location_id: 'LOC-1',
            created_at: '2026-08-02T12:00:00Z',
            state: 'CANCELED',
            line_items: [],
            total_money: { amount: 0, currency: 'USD' },
          },
        ],
      });

      await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      const txRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(txRows[0]!.status).toBe('VOIDED');
    });
  });

  describe('reconcileSquareOrders', () => {
    it('throws SquareNotConnectedError for a store with no Square connection', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await expect(reconcileSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY)).rejects.toThrow(
        SquareNotConnectedError
      );
    });

    it('finds and records an order the incremental sync watermark would never revisit', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);

      // Simulate an incremental sync that already ran to completion and advanced its watermark to
      // "now" — a missed webhook means the real order was never recorded, and a plain incremental
      // sync from this point forward would never look back far enough to find it.
      await adminDb
        .update(posConnections)
        .set({ ordersSyncCursor: null, ordersSyncWatermark: new Date() })
        .where(eq(posConnections.organizationId, organizationId));

      stubSquareOrdersResponse(oneCompletedOrder('ORDER-MISSED-WEBHOOK'));

      const result = await reconcileSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(result.transactionsRecorded).toBe(1);

      const txRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(txRows).toHaveLength(1);
      expect(txRows[0]!.externalId).toBe('ORDER-MISSED-WEBHOOK');

      const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]!.eventType).toBe('sales.ingested');
    });

    it('never advances ordersSyncCursor or ordersSyncWatermark, even after recording new orders', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);

      const fixedWatermark = new Date('2026-07-01T00:00:00Z');
      await adminDb
        .update(posConnections)
        .set({ ordersSyncCursor: 'stale-incremental-cursor', ordersSyncWatermark: fixedWatermark })
        .where(eq(posConnections.organizationId, organizationId));

      stubSquareOrdersResponse(oneCompletedOrder('ORDER-RECONCILED'));

      const result = await reconcileSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(result.transactionsRecorded).toBe(1);

      const connectionRows = await adminDb.select().from(posConnections).where(eq(posConnections.organizationId, organizationId));
      // The incremental sync's own state must be exactly what it was before reconciliation ran —
      // untouched by the reconciliation sweep's own real writes to sales_transactions/outbox_events.
      expect(connectionRows[0]!.ordersSyncCursor).toBe('stale-incremental-cursor');
      expect(connectionRows[0]!.ordersSyncWatermark!.toISOString()).toBe(fixedWatermark.toISOString());
    });

    it('re-running reconciliation over the same window is idempotent — no duplicate row, no duplicate outbox event', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);

      stubSquareOrdersResponse(oneCompletedOrder('ORDER-RECONCILE-IDEMPOTENT'));
      const first = await reconcileSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(first.transactionsRecorded).toBe(1);

      stubSquareOrdersResponse(oneCompletedOrder('ORDER-RECONCILE-IDEMPOTENT'));
      const second = await reconcileSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(second.transactionsRecorded).toBe(0);
      expect(second.transactionsDuplicate).toBe(1);

      const txRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(txRows).toHaveLength(1);

      const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
      expect(outboxRows).toHaveLength(1);
    });

    it('detects a refund on an order only the earlier incremental sync had recorded', async () => {
      const { organizationId, storeId } = await setUpOrgWithStore();
      await connectSquare(organizationId, storeId);

      // The incremental sync recorded the order previously; reconciliation now re-fetches the same
      // window and sees the order carries a refund the incremental sync never saw (e.g. its webhook
      // for the refund itself was the one that got dropped).
      stubSquareOrdersResponse(oneCompletedOrder('ORDER-REFUND-RECONCILED'));
      const initialSync = await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(initialSync.transactionsRecorded).toBe(1);

      stubSquareOrdersResponse({
        orders: [
          {
            ...oneCompletedOrder('ORDER-REFUND-RECONCILED').orders[0],
            refunds: [{ amount_money: { amount: 450, currency: 'USD' }, status: 'APPROVED' }],
          },
        ],
      });

      const result = await reconcileSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(result.transactionsDuplicate).toBe(1); // original order already existed
      expect(result.refundsProcessed).toBe(1);

      const refundRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(refundRows).toHaveLength(2); // original + REFUNDED row
      const refundRow = refundRows.find((r) => r.status === 'REFUNDED');
      expect(refundRow).toBeDefined();
      // amount_money.amount is in cents (Square's own convention) — 450 cents = $4.50, matching the
      // original order's own total.
      expect(refundRow!.total).toBe('4.5000');
    });
  });

  /**
   * end-to-end proof that a refund (1) records a REFUNDED transaction linked to the original, (2)
   * reduces net revenue, and (3) REVERSES the corresponding consumption — the three explicit
   * acceptance criteria, exercised together via a real product -> recipe -> menu item chain (same
   * fixture shape `sales-ingestion-pipeline.test.ts` already established) with a real lot, a real
   * COMPLETED order posting real consumption, then the same order re-synced with a refund attached.
   * Moved here from `apps/api/src/integrations/square-refunds.test.ts` (router-level, over HTTP)
   * when `syncSquareOrders` relocated to this package — same real assertions, called directly.
   */
  describe('Square refund handling — full consumption reversal', () => {
    afterEach(async () => {
      // Fully self-contained cleanup, in real FK order, for every table THIS describe block's
      // fixture (or the syncs it triggers) can write — not relying on execution order relative to
      // the shared top-level afterEach registered above (nested-describe afterEach ordering isn't
      // worth depending on here). sales_transaction_lines/stock_movements both FK into pos_items,
      // which FKs into menu_items, which FKs into recipes — deleted in that dependency order.
      for (const orgId of createdOrgIds) {
        await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
        await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
        await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
        await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
        await adminDb.delete(posItems).where(eq(posItems.organizationId, orgId));
        await adminDb.delete(posConnections).where(eq(posConnections.organizationId, orgId));
        await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
        await adminDb.delete(menuItems).where(eq(menuItems.organizationId, orgId));
        const orgRecipes = await adminDb.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
        for (const r of orgRecipes) {
          await adminDb.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
        }
        await adminDb.delete(recipes).where(eq(recipes.organizationId, orgId));
        await adminDb.delete(lots).where(eq(lots.organizationId, orgId));
        await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
        const orgProducts = await adminDb.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
        for (const p of orgProducts) {
          await adminDb.delete(productVariants).where(eq(productVariants.productId, p.id));
        }
        await adminDb.delete(products).where(eq(products.organizationId, orgId));
        await adminDb.delete(categories).where(eq(categories.organizationId, orgId));
        await adminDb.delete(stores).where(eq(stores.organizationId, orgId));
        await adminDb.delete(organizations).where(eq(organizations.id, orgId));
      }
      // Empties createdOrgIds so the shared top-level afterEach (still registered, still runs
      // after this one) finds nothing left for these orgs and its own deletes are all harmless
      // no-ops rather than double-deleting or racing this block's own cleanup above.
      createdOrgIds.length = 0;
    });

    /** A real product -> recipe -> menu item chain, a real lot with stock, and a real pos_items row
     * mapped to the menu item — everything triggerConsumptionForTransaction needs to post genuine
     * consumption, not a quarantine. */
    const setUpMappedMenuItemWithStock = async () => {
      const organizationId = generateId();
      createdOrgIds.push(organizationId);
      await adminDb.insert(organizations).values({
        id: organizationId,
        name: `Refund Test Org ${organizationId}`,
        slug: `refund-test-org-${organizationId}`,
        baseCurrency: 'USD',
      });
      const storeId = generateId();
      await adminDb.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

      const [gramUnit] = await adminDb.select({ id: units.id }).from(units).where(eq(units.code, 'g'));
      const [eachUnit] = await adminDb.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
      if (!gramUnit || !eachUnit) throw new Error('seeded units g/each not found — migrations not applied?');

      const productRepo = new ProductRepository(appDb, organizationId);
      const flour = await productRepo.create({
        id: generateId(),
        sku: `FLOUR-${generateId()}`,
        name: 'Flour',
        baseUnitId: gramUnit.id,
        type: 'INGREDIENT',
      });
      const flourVariantId = (await productRepo.findVariants(flour.id))[0]!.id;

      const recipeRepo = new RecipeRepository(appDb, organizationId);
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

      const menuItemRepo = new MenuItemRepository(appDb, organizationId);
      const menuItem = await menuItemRepo.create({
        id: generateId(),
        name: 'Simple Bun',
        recipeGroupId,
        price: '4.50',
        priceValidFrom: new Date('2026-01-01T00:00:00Z'),
      });

      const lotRepo = new LotRepository(appDb, organizationId);
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

      await connectSquare(organizationId, storeId);

      await adminDb.insert(posItems).values({
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

    const refundOrderWire = (externalId: string, refunds?: Array<{ amount_money: { amount: number; currency: string }; status: string }>) => ({
      orders: [orderWire(externalId, 'VAR-BUN-1', refunds)],
    });

    it('a genuinely mapped order posts real consumption via the recipe, not a quarantine', async () => {
      const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
      stubSquareOrdersResponse(refundOrderWire('ORDER-CONSUME-1'));

      await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);

      const movementRows = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
      expect(movementRows).toHaveLength(1);
      expect(movementRows[0]!.movementType).toBe('SALE_CONSUMPTION');
      expect(movementRows[0]!.quantity).toBe('-40.000000'); // 1 bun * 40g flour per the recipe

      const txRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(movementRows[0]!.sourceId).toBe(txRows[0]!.id); // traceable back to the real originating sale
    });

    it('a full refund on a previously-synced order records a REFUNDED transaction linked via refundOfId and fully reverses consumption', async () => {
      const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
      const orderId = 'ORDER-FULL-REFUND-1';

      stubSquareOrdersResponse(refundOrderWire(orderId));
      await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);

      const originalTxRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(originalTxRows).toHaveLength(1);
      const originalTx = originalTxRows[0]!;

      stubSquareOrdersResponse(refundOrderWire(orderId, [{ amount_money: { amount: 450, currency: 'USD' }, status: 'APPROVED' }]));
      const second = await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);
      expect(second.refundsProcessed).toBe(1);

      const allTxRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(allTxRows).toHaveLength(2); // the original COMPLETED row, plus a new REFUNDED row
      const refundRow = allTxRows.find((r) => r.status === 'REFUNDED');
      expect(refundRow).toBeDefined();
      expect(refundRow!.refundOfId).toBe(originalTx.id);
      expect(refundRow!.total).toBe('4.5000'); // the full refunded amount

      const movementRows = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
      expect(movementRows).toHaveLength(2); // the original consumption + its reversal
      const reversal = movementRows.find((m) => m.movementType === 'SALE_REVERSAL');
      expect(reversal).toBeDefined();
      expect(reversal!.quantity).toBe('40.000000'); // the FULL 40g flour returned — a 100% refund
    });

    it('a partial refund reverses consumption proportionally, not fully', async () => {
      const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
      const orderId = 'ORDER-PARTIAL-REFUND-1';

      stubSquareOrdersResponse(refundOrderWire(orderId));
      await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);

      // Refund exactly half the order total ($2.25 of $4.50).
      stubSquareOrdersResponse(refundOrderWire(orderId, [{ amount_money: { amount: 225, currency: 'USD' }, status: 'APPROVED' }]));
      await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);

      const refundRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      const refundRow = refundRows.find((r) => r.status === 'REFUNDED');
      expect(refundRow!.total).toBe('2.2500');

      const movementRows = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
      const reversal = movementRows.find((m) => m.movementType === 'SALE_REVERSAL');
      expect(reversal!.quantity).toBe('20.000000'); // 50% of the original 40g consumed — proportional, not full
    });

    it('a SECOND, later partial refund on the same order reverses only the INCREMENTAL amount, not a second full reversal', async () => {
      const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
      const orderId = 'ORDER-STAGED-REFUND-1';

      stubSquareOrdersResponse(refundOrderWire(orderId));
      await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);

      // First partial refund: $2.25 of $4.50 (50%).
      stubSquareOrdersResponse(refundOrderWire(orderId, [{ amount_money: { amount: 225, currency: 'USD' }, status: 'APPROVED' }]));
      await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);

      // A LATER sync sees the SAME order now fully refunded ($4.50 of $4.50) — the merchant issued
      // a second partial refund for the remaining half.
      stubSquareOrdersResponse(refundOrderWire(orderId, [{ amount_money: { amount: 450, currency: 'USD' }, status: 'APPROVED' }]));
      await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);

      const refundRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      const refundRowsOnly = refundRows.filter((r) => r.status === 'REFUNDED');
      expect(refundRowsOnly).toHaveLength(1); // updated in place, not a second row
      expect(refundRowsOnly[0]!.total).toBe('4.5000'); // now reflects the full refunded total

      const movementRows = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
      const reversals = movementRows.filter((m) => m.movementType === 'SALE_REVERSAL');
      expect(reversals).toHaveLength(2); // one for each incremental refund
      const totalReversed = reversals.reduce((sum, m) => sum + Number(m.quantity), 0);
      expect(totalReversed).toBe(40); // 20g (first 50%) + 20g (second 50%) = the full 40g, exactly once
    });

    it('a CANCELED order (a void) posts NO consumption — it never generated consumption to reverse', async () => {
      const { organizationId, storeId } = await setUpMappedMenuItemWithStock();
      stubSquareOrdersResponse({
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
      });

      await syncSquareOrders(appDb, organizationId, storeId, squareConfig, ENCRYPTION_KEY);

      const txRows = await adminDb.select().from(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
      expect(txRows[0]!.status).toBe('VOIDED');

      const movementRows = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
      expect(movementRows).toHaveLength(0); // a void never generated consumption in the first place
    });
  });
});
