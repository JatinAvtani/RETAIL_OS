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
      // A real receiving flow posts the RECEIPT movement AND creates the lot together (005-07's
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
});
