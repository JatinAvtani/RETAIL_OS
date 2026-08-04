import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  createDb,
  hashPassword,
  lots,
  memberships,
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
  users,
} from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string } } };

const asSuccess = (body: TrpcSuccess | TrpcError): TrpcSuccess['result']['data'] => {
  if (!('result' in body)) {
    throw new Error(`Expected a successful tRPC response, got an error: ${JSON.stringify(body)}`);
  }
  return body.result.data;
};

const asError = (body: TrpcSuccess | TrpcError): TrpcError['error'] => {
  if (!('error' in body)) {
    throw new Error(`Expected a tRPC error response, got success: ${JSON.stringify(body)}`);
  }
  return body.error;
};

/**
 * 005-16, the real authenticated behavior this session's Redis outage blocked writing/running
 * until now. Every prior new procedure (inventory.*, stocktake.*) had only "rejects when logged
 * out" proven (see inventory.test.ts) — this file proves the actual business logic against a real
 * running server, real Postgres, and a real Redis-backed session: store scoping genuinely denies a
 * Manager confined to a different store (404, not silently empty data), waste logging genuinely
 * posts a movement and reduces stock, and the stocktake state machine genuinely transitions and
 * genuinely enforces the large-variance-requires-a-reason rule.
 */
describe('inventory + stocktake routers — authenticated business logic', () => {
  let app: FastifyInstance;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    // Every table that references users (stock_counts.submittedByUserId/approvedByUserId/
    // createdByUserId, stock_count_lines.countedByUserId, audit_logs.actorUserId,
    // stock_movements.actorUserId — all written by a real MovementService.postMovementInTx call,
    // which every logWaste/stocktake-approval request in this file makes) MUST be cleaned up
    // BEFORE the createdUserIds loop deletes those users, or the FK blocks it. Consolidated into
    // one block after hitting this exact ordering bug three separate times while writing this
    // file (stock_counts, then audit_logs, then stock_movements each surfaced it in turn) — the
    // same recurring class flagged repeatedly in project memory, now handled as one group instead
    // of fixed table by table.
    for (const orgId of createdOrgIds) {
      const orgCounts = await db.select({ id: stockCounts.id }).from(stockCounts).where(eq(stockCounts.organizationId, orgId));
      for (const c of orgCounts) {
        await db.delete(stockCountLines).where(eq(stockCountLines.stockCountId, c.id));
      }
      await db.delete(stockCounts).where(eq(stockCounts.organizationId, orgId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
    }

    for (const userId of createdUserIds) {
      const tokens = await redis.smembers(`user-sessions:${userId}`);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => `session:${t}`), `user-sessions:${userId}`);
      }
      await db.delete(memberships).where(eq(memberships.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    for (const orgId of createdOrgIds) {
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await db.delete(lots).where(eq(lots.organizationId, orgId));

      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdUserIds.length = 0;
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const uniqueEmail = (label: string) =>
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  /** A real org, a real Owner (all stores), a real store, and a real product with received stock. */
  const setUpOrgWithStock = async (): Promise<{
    organizationId: string;
    storeId: string;
    productId: string;
    variantId: string;
    sessionCookie: string;
  }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Inventory Test Org ${organizationId}`,
      slug: `inventory-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    await db.insert(products).values({
      id: productId,
      organizationId,
      sku: `inventory-test-${productId}`,
      name: 'Test Ingredient',
      baseUnitId: eachUnit!.id,
      type: 'INGREDIENT',
    });
    const variantId = generateId();
    await db.insert(productVariants).values({ id: variantId, productId, name: 'Test Ingredient', isDefault: true });

    // A real RECEIPT movement + projection upsert + a real ACTIVE lot, via plain inserts mirroring
    // MovementService.postMovementInTx's own writes — this test file deliberately builds fixtures
    // with plain inserts (matching cross-tenant.test.ts's own convention), not by going through
    // TenantScopedRepository machinery that expects a raw postgres client, not the Drizzle db
    // instance apps/api's own createDb returns. The lot row is REQUIRED, not optional set-dressing
    // — logWaste/consumeFefo draw from `lots`, not from `stock_levels` (the projection is a cache
    // of the ledger sum, entirely separate from the FEFO allocation pool); a first draft of this
    // fixture omitted it and every waste/stocktake test genuinely failed with "not enough stock"
    // even though stock_levels showed 20 — a real reminder that the projection and the lot pool are
    // two different things, not the same fact viewed two ways.
    const lotId = generateId();
    await db.insert(lots).values({
      id: lotId,
      organizationId,
      storeId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '20.000000',
      remainingQuantity: '20.000000',
      unitCost: '2.0000',
      currency: 'USD',
      status: 'ACTIVE',
    });
    await db.insert(stockMovements).values({
      id: generateId(),
      organizationId,
      storeId,
      productId,
      variantId,
      lotId,
      movementType: 'RECEIPT',
      quantity: '20.000000',
      unitCost: '2.0000',
      currency: 'USD',
      occurredAt: new Date(),
      sourceType: 'manual',
    });
    await db.insert(stockLevels).values({
      organizationId,
      storeId,
      productId,
      variantId,
      quantity: '20.000000',
      avgUnitCost: '2.0000',
      lastMovementAt: new Date(),
    });

    const email = uniqueEmail('inventory-owner');
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({
      id: generateId(),
      organizationId,
      userId,
      role: 'OWNER',
      acceptedAt: new Date(),
      // storeIds left null -> canAccessStore treats this as 'ALL', matching establish-session.ts.
    });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password },
    });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    return { organizationId, storeId, productId, variantId, sessionCookie };
  };

  /** A Manager whose membership.storeIds is a real, non-empty array EXCLUDING the org's existing store — the exact case org-level RLS alone can't catch (spec 14 §14.3 rule 2). The excluded store's own id isn't needed here (only a DIFFERENT real store must exist for storeIds to be non-empty); the caller already knows which store to attack with. */
  const setUpManagerScopedAwayFromStore = async (organizationId: string): Promise<string> => {
    const otherStoreId = generateId();
    await db.insert(stores).values({ id: otherStoreId, organizationId, name: 'Other Store', timezone: 'America/New_York' });

    const email = uniqueEmail('inventory-manager');
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({
      id: generateId(),
      organizationId,
      userId,
      role: 'MANAGER',
      acceptedAt: new Date(),
      storeIds: [otherStoreId],
    });

    const loginResponse = await app.inject({ method: 'POST', url: '/trpc/auth.login', payload: { email, password } });
    return loginResponse.cookies.find((c) => c.name === '__Host-session')!.value;
  };

  it('levels returns the real stock this org received', async () => {
    const { storeId, productId, variantId, sessionCookie } = await setUpOrgWithStock();

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/inventory.levels?input=${encodeURIComponent(JSON.stringify({ storeId }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const levels = asSuccess(response.json()) as unknown as Array<{ productId: string; variantId: string; quantity: string }>;
    const found = levels.find((l) => l.productId === productId && l.variantId === variantId);
    expect(found?.quantity).toBe('20.000000');
  });

  it('a Manager scoped to a different store is denied inventory.levels for this store (404, not empty data)', async () => {
    const { organizationId, storeId } = await setUpOrgWithStock();
    const managerCookie = await setUpManagerScopedAwayFromStore(organizationId);

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/inventory.levels?input=${encodeURIComponent(JSON.stringify({ storeId }))}`,
      cookies: { '__Host-session': managerCookie },
    });

    expect(response.statusCode).toBe(404);
    const error = asError(response.json());
    expect(error.data.code).toBe('NOT_FOUND');
  });

  it('logWaste genuinely posts a WASTE movement and reduces stock_levels', async () => {
    const { storeId, productId, variantId, sessionCookie } = await setUpOrgWithStock();

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/inventory.logWaste',
      payload: { storeId, productId, variantId, quantity: '5.000000', reasonCode: 'SPILLAGE' },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const posted = asSuccess(response.json()) as { movements: Array<{ movementType: string; quantity: string }> };
    expect(posted.movements[0]?.movementType).toBe('WASTE');
    expect(posted.movements[0]?.quantity).toBe('-5.000000');

    const levelsResponse = await app.inject({
      method: 'GET',
      url: `/trpc/inventory.levels?input=${encodeURIComponent(JSON.stringify({ storeId }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    const levels = asSuccess(levelsResponse.json()) as unknown as Array<{ productId: string; variantId: string; quantity: string }>;
    const found = levels.find((l) => l.productId === productId && l.variantId === variantId);
    expect(found?.quantity).toBe('15.000000');
  });

  it('logWaste rejects an invalid reason code (real DB CHECK constraint, not just a TS union)', async () => {
    const { storeId, productId, variantId, sessionCookie } = await setUpOrgWithStock();

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/inventory.logWaste',
      payload: { storeId, productId, variantId, quantity: '1.000000', reasonCode: 'NOT_A_REAL_REASON' },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).not.toBe(200);
  });

  it('the full stocktake lifecycle: create -> start (freezes T0) -> enter -> submit -> approve, ending with a real COUNT_ADJUSTMENT movement', async () => {
    const { storeId, productId, variantId, sessionCookie } = await setUpOrgWithStock();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.createFull',
      payload: { storeId, productVariantPairs: [{ productId, variantId }] },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(createResponse.statusCode).toBe(200);
    const count = asSuccess(createResponse.json()) as { id: string; status: string };
    expect(count.status).toBe('DRAFT');

    const startResponse = await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.start',
      payload: { stockCountId: count.id },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(startResponse.statusCode).toBe(200);
    const started = asSuccess(startResponse.json()) as { status: string; tOAt?: string };
    expect(started.status).toBe('IN_PROGRESS');

    const getResponse = await app.inject({
      method: 'GET',
      url: `/trpc/stocktake.get?input=${encodeURIComponent(JSON.stringify({ stockCountId: count.id }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    const detail = asSuccess(getResponse.json()) as {
      lines: Array<{ line: { id: string; theoreticalQuantityT0: string } }>;
    };
    const line = detail.lines[0]!;
    expect(line.line.theoreticalQuantityT0).toBe('20.000000');

    // A real physical count of 18 (a shortfall of 2 against the frozen T0 theoretical of 20).
    const enterResponse = await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.enterCount',
      payload: { stockCountLineId: line.line.id, countedQuantity: '18.000000' },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(enterResponse.statusCode).toBe(200);

    const submitResponse = await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.submit',
      payload: { stockCountId: count.id },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(submitResponse.statusCode).toBe(200);
    const submitted = asSuccess(submitResponse.json()) as { status: string };
    expect(submitted.status).toBe('SUBMITTED');

    // A -2 variance against a 20 theoretical is exactly 10% -- at the LARGE_VARIANCE_THRESHOLD
    // boundary, so a reason is required before approval can succeed.
    const reasonResponse = await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.setLineReason',
      payload: { stockCountLineId: line.line.id, reasonCode: 'Spillage discovered during count' },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(reasonResponse.statusCode).toBe(200);

    const approveResponse = await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.approve',
      payload: { stockCountId: count.id },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(approveResponse.statusCode).toBe(200);
    const approved = asSuccess(approveResponse.json()) as { status: string };
    expect(approved.status).toBe('APPROVED');

    const finalLevelsResponse = await app.inject({
      method: 'GET',
      url: `/trpc/inventory.levels?input=${encodeURIComponent(JSON.stringify({ storeId }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    const finalLevels = asSuccess(finalLevelsResponse.json()) as unknown as Array<{ productId: string; variantId: string; quantity: string }>;
    const finalLevel = finalLevels.find((l) => l.productId === productId && l.variantId === variantId);
    expect(finalLevel?.quantity).toBe('18.000000');
  });

  it('approve is rejected with a large, unexplained variance and no reason code set', async () => {
    const { storeId, productId, variantId, sessionCookie } = await setUpOrgWithStock();

    const count = asSuccess(
      (
        await app.inject({
          method: 'POST',
          url: '/trpc/stocktake.createFull',
          payload: { storeId, productVariantPairs: [{ productId, variantId }] },
          cookies: { '__Host-session': sessionCookie },
        })
      ).json()
    ) as { id: string };

    await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.start',
      payload: { stockCountId: count.id },
      cookies: { '__Host-session': sessionCookie },
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: `/trpc/stocktake.get?input=${encodeURIComponent(JSON.stringify({ stockCountId: count.id }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    const detail = asSuccess(getResponse.json()) as { lines: Array<{ line: { id: string } }> };
    const lineId = detail.lines[0]!.line.id;

    // A 15-unit shortfall against a 20-unit theoretical is 75% -- well past the 10% threshold, and
    // no reason code is ever set.
    await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.enterCount',
      payload: { stockCountLineId: lineId, countedQuantity: '5.000000' },
      cookies: { '__Host-session': sessionCookie },
    });
    await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.submit',
      payload: { stockCountId: count.id },
      cookies: { '__Host-session': sessionCookie },
    });

    const approveResponse = await app.inject({
      method: 'POST',
      url: '/trpc/stocktake.approve',
      payload: { stockCountId: count.id },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(approveResponse.statusCode).not.toBe(200);
    const error = asError(approveResponse.json());
    expect(error.data.code).toBe('BAD_REQUEST');
  });
});
