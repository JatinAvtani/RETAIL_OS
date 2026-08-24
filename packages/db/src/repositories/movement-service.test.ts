import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import {
  auditLogs,
  lots,
  organizations,
  outboxEvents,
  productVariants,
  products,
  stockLevels,
  stockMovements,
  stores,
  units,
  users,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { withTenantContext } from '../tenant-context';
import { MovementService, IdempotentReplayError, InsufficientStockError } from './movement-service';
import { LotRepository } from './lot-repository';
import { ProductRepository } from './product-repository';
import { StockLevelRepository } from './stock-level-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('MovementService', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;
  let unitId: string;
  let productId: string;
  let variantId: string;
  let userId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Movement Service Test Org',
      slug: `movement-service-test-${organizationId}`,
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
      name: 'Flour',
      baseUnitId: unitId,
      type: 'INGREDIENT',
    });
    productId = product.id;
    variantId = (await productRepo.findVariants(productId))[0]!.id;

    userId = generateId();
    await adminDb.insert(users).values({ id: userId, email: `movement-service-${userId}@example.test` });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId));
    await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
    await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, organizationId));
    await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    await adminDb.delete(lots).where(eq(lots.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(productVariants).where(eq(productVariants.productId, productId));
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await adminDb.delete(users).where(eq(users.id, userId));
    await client.end();
    await adminClient.end();
  });

  describe('postMovement', () => {
    it('posts a real movement, projection, outbox event, and audit log entry, all together', async () => {
      const service = new MovementService(createScopedDb(client), organizationId);
      const { movement, projection } = await service.postMovement({
        storeId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '100.000000',
        unitCost: '2.0000',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'manual',
      });

      expect(movement.quantity).toBe('100.000000');
      expect(projection.quantity).toBe('100.000000');

      const adminDb = drizzle(adminClient, { schema });
      const outboxRows = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, movement.id));
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]?.eventType).toBe('stock.moved');
      expect(outboxRows[0]?.publishedAt).toBeNull();

      const auditRows = await adminDb.select().from(auditLogs).where(eq(auditLogs.entityId, movement.id));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.action).toBe('stock_movement.recorded');
      expect(auditRows[0]?.actorType).toBe('SYSTEM');
    });

    it('records actorType as USER when an actorUserId is given', async () => {
      const service = new MovementService(createScopedDb(client), organizationId);
      const { movement } = await service.postMovement({
        storeId,
        productId,
        variantId,
        movementType: 'COUNT_ADJUSTMENT',
        quantity: '-2.000000',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'stocktake',
        actorUserId: userId,
      });

      const adminDb = drizzle(adminClient, { schema });
      const auditRows = await adminDb.select().from(auditLogs).where(eq(auditLogs.entityId, movement.id));
      expect(auditRows[0]?.actorType).toBe('USER');
    });

    it('rejects a replayed idempotency key with a typed error, not a raw duplicate-key exception', async () => {
      const service = new MovementService(createScopedDb(client), organizationId);
      const key = `idem-${generateId()}`;

      await service.postMovement({
        storeId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '5.000000',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
        idempotencyKey: key,
      });

      await expect(
        service.postMovement({
          storeId,
          productId,
          variantId,
          movementType: 'RECEIPT',
          quantity: '5.000000',
          currency: 'USD',
          occurredAt: new Date(),
          sourceType: 'pos-sync',
          idempotencyKey: key,
        })
      ).rejects.toThrow(IdempotentReplayError);

      // Confirm the replay attempt genuinely did NOT double-post — only one movement exists.
      const adminDb = drizzle(adminClient, { schema });
      const movementRows = await adminDb
        .select()
        .from(stockMovements)
        .where(eq(stockMovements.idempotencyKey, key));
      expect(movementRows).toHaveLength(1);
    });

    it('a rejected idempotent replay leaves no partial outbox/audit rows behind (the whole attempt rolls back)', async () => {
      const service = new MovementService(createScopedDb(client), organizationId);
      const key = `idem-rollback-${generateId()}`;

      await service.postMovement({
        storeId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '3.000000',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
        idempotencyKey: key,
      });

      const adminDb = drizzle(adminClient, { schema });
      const outboxBefore = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));

      await expect(
        service.postMovement({
          storeId,
          productId,
          variantId,
          movementType: 'RECEIPT',
          quantity: '3.000000',
          currency: 'USD',
          occurredAt: new Date(),
          sourceType: 'pos-sync',
          idempotencyKey: key,
        })
      ).rejects.toThrow(IdempotentReplayError);

      const outboxAfter = await adminDb.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organizationId));
      expect(outboxAfter).toHaveLength(outboxBefore.length);
    });
  });

  describe('consumeFefo concurrency (I3)', () => {
    it('two concurrent consumers of the same lot cannot drive it negative — one succeeds, the other is refused', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      const lot = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-01T00:00:00Z'),
        initialQuantity: '10.000000',
        unitCost: '1.0000',
        currency: 'USD',
      });

      // Two SEPARATE connections — a single pooled client would serialise these itself and prove
      // nothing about row locking. Each draws 8 from a lot holding 10: exactly one can succeed.
      const clientA = postgres(APP_CONNECTION_STRING);
      const clientB = postgres(APP_CONNECTION_STRING);
      try {
        const draw = (c: ReturnType<typeof postgres>) =>
          new MovementService(createScopedDb(c), organizationId).consumeFefo({
            storeId,
            productId,
            variantId,
            requiredQuantity: '8.000000',
            unit: 'g',
            occurredAt: new Date(),
            sourceType: 'pos-sync',
          });

        const outcomes = await Promise.allSettled([draw(clientA), draw(clientB)]);
        const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
        const rejected = outcomes.filter((o) => o.status === 'rejected');

        // Before the FOR UPDATE + quantity guard, BOTH succeeded and left the lot at -6.000000 —
        // verified directly against Postgres with two concurrent psql sessions.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const finalLot = await lotRepo.findById(lot.id);
        expect(Number(finalLot?.remainingQuantity)).toBeGreaterThanOrEqual(0);
        expect(finalLot?.remainingQuantity).toBe('2.000000');
      } finally {
        await clientA.end();
        await clientB.end();
      }
    });
  });

  describe('consumeFefo', () => {
    it('allocates from the earliest-expiring lot, draws it down, and posts a SALE_CONSUMPTION movement at that lot\'s cost', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      const earlierExpiry = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-01T00:00:00Z'),
        expiryDate: '2026-08-10',
        initialQuantity: '20.000000',
        unitCost: '1.5000',
        currency: 'USD',
      });
      await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-02T00:00:00Z'),
        expiryDate: '2026-09-01',
        initialQuantity: '20.000000',
        unitCost: '3.0000',
        currency: 'USD',
      });

      const service = new MovementService(createScopedDb(client), organizationId);
      const result = await service.consumeFefo({
        storeId,
        productId,
        variantId,
        requiredQuantity: '5.000000',
        unit: 'g',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
      });

      expect(result.movements).toHaveLength(1);
      expect(result.movements[0]?.lotId).toBe(earlierExpiry.id);
      expect(result.movements[0]?.quantity).toBe('-5.000000');
      expect(result.movements[0]?.unitCost).toBe('1.5000');
      expect(result.totalCost?.amount.toString()).toBe('7.5');

      const updatedLot = await lotRepo.findById(earlierExpiry.id);
      expect(updatedLot?.remainingQuantity).toBe('15.000000');
    });

    it('spans multiple lots when the first is insufficient, drawing each at its own cost', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      const first = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-01T00:00:00Z'),
        expiryDate: '2026-08-05',
        initialQuantity: '3.000000',
        unitCost: '2.0000',
        currency: 'USD',
      });
      const second = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-02T00:00:00Z'),
        expiryDate: '2026-08-20',
        initialQuantity: '10.000000',
        unitCost: '4.0000',
        currency: 'USD',
      });

      const service = new MovementService(createScopedDb(client), organizationId);
      const result = await service.consumeFefo({
        storeId,
        productId,
        variantId,
        requiredQuantity: '5.000000',
        unit: 'g',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
      });

      expect(result.movements).toHaveLength(2);
      expect(result.movements[0]?.lotId).toBe(first.id);
      expect(result.movements[0]?.quantity).toBe('-3.000000');
      expect(result.movements[1]?.lotId).toBe(second.id);
      expect(result.movements[1]?.quantity).toBe('-2.000000');
      // 3 * 2.00 + 2 * 4.00 = 14.00
      expect(result.totalCost?.amount.toString()).toBe('14');

      const firstAfter = await lotRepo.findById(first.id);
      expect(firstAfter?.status).toBe('DEPLETED');
    });

    it('throws InsufficientStockError and posts NOTHING when lots cannot cover the requirement', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date(),
        initialQuantity: '2.000000',
        unitCost: '1.0000',
        currency: 'USD',
      });

      const service = new MovementService(createScopedDb(client), organizationId);
      await expect(
        service.consumeFefo({
          storeId,
          productId,
          variantId,
          requiredQuantity: '10.000000',
          unit: 'g',
          occurredAt: new Date(),
          sourceType: 'pos-sync',
        })
      ).rejects.toThrow(InsufficientStockError);

      // Confirm the whole attempt rolled back — no movement, no lot draw.
      const adminDb = drizzle(adminClient, { schema });
      const movementRows = await adminDb
        .select()
        .from(stockMovements)
        .where(eq(stockMovements.organizationId, organizationId));
      expect(movementRows).toHaveLength(0);

      const lotAfter = await lotRepo.findFefoCandidates(storeId, productId);
      expect(lotAfter[0]?.remainingQuantity).toBe('2.000000');
    });

    it('the projection reflects both a posted RECEIPT and consumeFefo\'s consumption exactly (the ledger-projection consistency invariant, end to end)', async () => {
      // A real receiving flow posts the RECEIPT movement AND creates the lot together (earlier work's
      // job); this test does both explicitly to prove the projection tracks the full ledger, not
      // just consumeFefo's own writes in isolation.
      const service = new MovementService(createScopedDb(client), organizationId);
      await service.postMovement({
        storeId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '20.000000',
        unitCost: '1.0000',
        currency: 'USD',
        occurredAt: new Date(),
        sourceType: 'manual',
      });

      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date(),
        initialQuantity: '20.000000',
        unitCost: '1.0000',
        currency: 'USD',
      });

      await service.consumeFefo({
        storeId,
        productId,
        variantId,
        requiredQuantity: '8.000000',
        unit: 'g',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
      });

      const levelRepo = new StockLevelRepository(createScopedDb(client), organizationId);
      const level = await levelRepo.find(storeId, productId, variantId);
      expect(level?.quantity).toBe('12.000000');

      const adminDb = drizzle(adminClient, { schema });
      const ledgerRows = await adminDb
        .select()
        .from(stockMovements)
        .where(eq(stockMovements.organizationId, organizationId));
      const ledgerSum = ledgerRows.reduce((sum, r) => sum + Number(r.quantity), 0);
      expect(ledgerSum).toBe(12);
    });
  });

  describe('reverseSaleConsumption', () => {
    it('a full reversal (fraction 1) returns the entire consumed quantity to the exact lot it was drawn from, reviving it to ACTIVE if it was DEPLETED', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      const lot = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-01T00:00:00Z'),
        initialQuantity: '5.000000', // exactly enough to be fully depleted by the sale below
        unitCost: '2.0000',
        currency: 'USD',
      });

      const scopedDb = createScopedDb(client);
      const service = new MovementService(scopedDb, organizationId);
      const saleTransactionId = generateId();
      const consumeResult = await service.consumeFefo({
        storeId,
        productId,
        variantId,
        requiredQuantity: '5.000000',
        unit: 'g',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
        sourceId: saleTransactionId,
      });
      expect(consumeResult.movements[0]?.quantity).toBe('-5.000000');

      const depletedLot = await lotRepo.findById(lot.id);
      expect(depletedLot?.status).toBe('DEPLETED');
      expect(depletedLot?.remainingQuantity).toBe('0.000000');

      const reversals = await scopedDb.transaction((tx) =>
        withTenantContext(tx, organizationId, () =>
          service.reverseSaleConsumption(tx, {
            originalSourceId: saleTransactionId,
            fraction: '1',
            occurredAt: new Date(),
            sourceType: 'pos-sync-refund',
            sourceId: saleTransactionId,
          })
        )
      );

      expect(reversals).toHaveLength(1);
      expect(reversals[0]?.movementType).toBe('SALE_REVERSAL');
      expect(reversals[0]?.quantity).toBe('5.000000'); // positive — stock coming back
      expect(reversals[0]?.lotId).toBe(lot.id);

      const revivedLot = await lotRepo.findById(lot.id);
      expect(revivedLot?.status).toBe('ACTIVE');
      expect(revivedLot?.remainingQuantity).toBe('5.000000');
    });

    it('a partial reversal (fraction 0.5) returns exactly half the consumed quantity', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-01T00:00:00Z'),
        initialQuantity: '20.000000',
        unitCost: '1.0000',
        currency: 'USD',
      });

      const scopedDb = createScopedDb(client);
      const service = new MovementService(scopedDb, organizationId);
      // lotRepo.receive only creates the lot row — the stock_levels PROJECTION needs its own real
      // RECEIPT movement too (same precedent consumeFefo's own "ledger-projection consistency" test
      // establishes above), or stockLevels.quantity starts at 0, not the lot's initialQuantity.
      await service.postMovement({
        storeId,
        productId,
        variantId,
        movementType: 'RECEIPT',
        quantity: '20.000000',
        unitCost: '1.0000',
        currency: 'USD',
        occurredAt: new Date('2026-08-01T00:00:00Z'),
        sourceType: 'manual',
      });
      const saleTransactionId = generateId();
      await service.consumeFefo({
        storeId,
        productId,
        variantId,
        requiredQuantity: '10.000000',
        unit: 'g',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
        sourceId: saleTransactionId,
      });

      const reversals = await scopedDb.transaction((tx) =>
        withTenantContext(tx, organizationId, () =>
          service.reverseSaleConsumption(tx, {
            originalSourceId: saleTransactionId,
            fraction: '0.5',
            occurredAt: new Date(),
            sourceType: 'pos-sync-refund',
          })
        )
      );

      expect(reversals[0]?.quantity).toBe('5.000000'); // 50% of the original 10 consumed

      const levelRepo = new StockLevelRepository(createScopedDb(client), organizationId);
      const level = await levelRepo.find(storeId, productId, variantId);
      expect(level?.quantity).toBe('15.000000'); // 20 received - 10 consumed + 5 returned = 15
    });

    it('a sourceId with no matching SALE_CONSUMPTION rows reverses nothing — no error, no movement', async () => {
      const scopedDb = createScopedDb(client);
      const service = new MovementService(scopedDb, organizationId);
      const reversals = await scopedDb.transaction((tx) =>
        withTenantContext(tx, organizationId, () =>
          service.reverseSaleConsumption(tx, {
            originalSourceId: generateId(),
            fraction: '1',
            occurredAt: new Date(),
            sourceType: 'pos-sync-refund',
          })
        )
      );
      expect(reversals).toHaveLength(0);
    });

    it('reversing twice at fraction 1 against the same consumption is rejected by the real lots_remaining_within_initial CHECK constraint — a genuine database backstop, not just application discipline', async () => {
      // reverseSaleConsumption is a pure "apply this fraction against what was consumed" primitive
      // with no memory of prior reversals — the caller is what
      // computes the INCREMENTAL fraction so a second sync of the same refund doesn't double-
      // reverse. This test proves what happens if a caller ever got that wrong anyway: the database
      // itself refuses to let a lot's remainingQuantity exceed its initialQuantity, so a genuine
      // double-reversal fails loudly with a real Postgres error rather than silently over-crediting
      // stock that was never actually returned.
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-01T00:00:00Z'),
        initialQuantity: '20.000000',
        unitCost: '1.0000',
        currency: 'USD',
      });

      const scopedDb = createScopedDb(client);
      const service = new MovementService(scopedDb, organizationId);
      const saleTransactionId = generateId();
      await service.consumeFefo({
        storeId,
        productId,
        variantId,
        requiredQuantity: '10.000000',
        unit: 'g',
        occurredAt: new Date(),
        sourceType: 'pos-sync',
        sourceId: saleTransactionId,
      });

      const reverseOnce = () =>
        scopedDb.transaction((tx) =>
          withTenantContext(tx, organizationId, () =>
            service.reverseSaleConsumption(tx, {
              originalSourceId: saleTransactionId,
              fraction: '1',
              occurredAt: new Date(),
              sourceType: 'pos-sync-refund',
            })
          )
        );

      // First reversal brings remainingQuantity back to exactly 20 (the lot's own initialQuantity)
      // — the maximum genuinely valid value.
      await reverseOnce();
      const afterFirst = await lotRepo.findFefoCandidates(storeId, productId);
      expect(afterFirst[0]?.remainingQuantity).toBe('20.000000');

      // A second reversal of the SAME consumption would push remainingQuantity to 30, exceeding
      // initialQuantity — the real CHECK constraint rejects this outright.
      await expect(reverseOnce()).rejects.toThrow(/lots_remaining_within_initial/);
    });
  });

  describe('logWaste', () => {
    it('allocates from the earliest-expiring lot via FEFO, draws it down, and posts a WASTE movement with the given reason code', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      const earlierExpiry = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-01T00:00:00Z'),
        expiryDate: '2026-08-10',
        initialQuantity: '20.000000',
        unitCost: '1.5000',
        currency: 'USD',
      });
      await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-02T00:00:00Z'),
        expiryDate: '2026-09-01',
        initialQuantity: '20.000000',
        unitCost: '3.0000',
        currency: 'USD',
      });

      const service = new MovementService(createScopedDb(client), organizationId);
      const result = await service.logWaste({
        storeId,
        productId,
        variantId,
        quantity: '5.000000',
        unit: 'g',
        reasonCode: 'EXPIRED',
        occurredAt: new Date(),
        sourceType: 'manual',
      });

      expect(result.movements).toHaveLength(1);
      expect(result.movements[0]?.lotId).toBe(earlierExpiry.id);
      expect(result.movements[0]?.quantity).toBe('-5.000000');
      expect(result.movements[0]?.movementType).toBe('WASTE');
      expect(result.movements[0]?.reasonCode).toBe('EXPIRED');
      expect(result.totalCost?.amount.toString()).toBe('7.5');

      const updatedLot = await lotRepo.findById(earlierExpiry.id);
      expect(updatedLot?.remainingQuantity).toBe('15.000000');
    });

    it('throws InsufficientStockError rather than silently posting a partial waste log', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date(),
        initialQuantity: '2.000000',
        unitCost: '1.0000',
        currency: 'USD',
      });

      const service = new MovementService(createScopedDb(client), organizationId);
      await expect(
        service.logWaste({
          storeId,
          productId,
          variantId,
          quantity: '10.000000',
          unit: 'g',
          reasonCode: 'DAMAGED',
          occurredAt: new Date(),
          sourceType: 'manual',
        })
      ).rejects.toThrow(InsufficientStockError);

      const adminDb = drizzle(adminClient, { schema });
      const movements = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
      expect(movements).toHaveLength(0);
    });

    it('a real invalid reason code is rejected by the database itself, not just this method\'s TypeScript type', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date(),
        initialQuantity: '10.000000',
        unitCost: '1.0000',
        currency: 'USD',
      });

      const service = new MovementService(createScopedDb(client), organizationId);
      // Bypasses the TypeScript union deliberately, proving the CHECK constraint is a real
      // database backstop and not merely a compile-time convenience.
      await expect(
        service.logWaste({
          storeId,
          productId,
          variantId,
          quantity: '1.000000',
          unit: 'g',
          reasonCode: 'NOT_A_REAL_REASON' as never,
          occurredAt: new Date(),
          sourceType: 'manual',
        })
      ).rejects.toThrow();
    });
  });

  describe('logWasteFromLot', () => {
    it('draws the exact specified lot (overriding FEFO order) and posts a WASTE movement at that lot\'s cost', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      const earlierExpiry = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-01T00:00:00Z'),
        expiryDate: '2026-08-10',
        initialQuantity: '20.000000',
        unitCost: '1.5000',
        currency: 'USD',
      });
      const laterExpiry = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date('2026-08-02T00:00:00Z'),
        expiryDate: '2026-09-01',
        initialQuantity: '20.000000',
        unitCost: '3.0000',
        currency: 'USD',
      });

      // FEFO would pick earlierExpiry first — this proves the override deliberately draws the
      // LATER-expiring lot instead, since a real operator sometimes knows the specific batch
      // that's actually spoiled.
      const service = new MovementService(createScopedDb(client), organizationId);
      const result = await service.logWasteFromLot({
        storeId,
        productId,
        variantId,
        lotId: laterExpiry.id,
        quantity: '4.000000',
        reasonCode: 'QUALITY_REJECT',
        occurredAt: new Date(),
        sourceType: 'manual',
      });

      expect(result.movement.lotId).toBe(laterExpiry.id);
      expect(result.movement.quantity).toBe('-4.000000');
      expect(result.movement.movementType).toBe('WASTE');
      expect(result.movement.reasonCode).toBe('QUALITY_REJECT');
      expect(result.unitCost.amount.toString()).toBe('3');

      const untouchedLot = await lotRepo.findById(earlierExpiry.id);
      expect(untouchedLot?.remainingQuantity).toBe('20.000000');
      const drawnLot = await lotRepo.findById(laterExpiry.id);
      expect(drawnLot?.remainingQuantity).toBe('16.000000');
    });

    it('throws rather than drawing more than the specified lot actually has remaining', async () => {
      const lotRepo = new LotRepository(createScopedDb(client), organizationId);
      const lot = await lotRepo.receive({
        id: generateId(),
        storeId,
        productId,
        variantId,
        receivedAt: new Date(),
        initialQuantity: '3.000000',
        unitCost: '1.0000',
        currency: 'USD',
      });

      const service = new MovementService(createScopedDb(client), organizationId);
      await expect(
        service.logWasteFromLot({
          storeId,
          productId,
          variantId,
          lotId: lot.id,
          quantity: '10.000000',
          reasonCode: 'SPILLAGE',
          occurredAt: new Date(),
          sourceType: 'manual',
        })
      ).rejects.toThrow(InsufficientStockError);

      const untouchedLot = await lotRepo.findById(lot.id);
      expect(untouchedLot?.remainingQuantity).toBe('3.000000');
    });
  });
});
