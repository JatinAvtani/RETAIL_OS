import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
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
  stockTransfers,
  stores,
  units,
  users,
} from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { InvalidTransferTransitionError, TransferService } from './transfer-service';
import { InsufficientStockError } from './movement-service';
import { LotRepository } from './lot-repository';
import { ProductRepository } from './product-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('TransferService', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let sourceStoreId: string;
  let destinationStoreId: string;
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
      name: 'Transfer Test Org',
      slug: `transfer-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    sourceStoreId = generateId();
    await adminDb.insert(stores).values({ id: sourceStoreId, organizationId, name: 'Source Store', timezone: 'America/New_York' });
    destinationStoreId = generateId();
    await adminDb.insert(stores).values({ id: destinationStoreId, organizationId, name: 'Destination Store', timezone: 'America/New_York' });

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
    await adminDb.insert(users).values({ id: userId, email: `transfer-${userId}@example.test` });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stockTransfers).where(eq(stockTransfers.organizationId, organizationId));
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

  it('initiateTransfer posts TRANSFER_OUT at the source, draws down the source lot, and creates a new IN_TRANSIT lot at the destination carrying the same cost/expiry', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    const sourceLot = await lotRepo.receive({
      id: generateId(),
      storeId: sourceStoreId,
      productId,
      variantId,
      receivedAt: new Date('2026-08-01T00:00:00Z'),
      expiryDate: '2026-09-01',
      initialQuantity: '50.000000',
      unitCost: '2.5000',
      currency: 'USD',
    });

    const service = new TransferService(createScopedDb(client), organizationId);
    const result = await service.initiateTransfer({
      sourceStoreId,
      destinationStoreId,
      productId,
      variantId,
      quantity: '20.000000',
      unit: 'g',
      occurredAt: new Date(),
      sourceType: 'manual',
      actorUserId: userId,
    });

    expect(result.transfer.status).toBe('IN_TRANSIT');
    expect(result.outMovement.movementType).toBe('TRANSFER_OUT');
    expect(result.outMovement.quantity).toBe('-20.000000');
    expect(result.outMovement.storeId).toBe(sourceStoreId);

    const updatedSourceLot = await lotRepo.findById(sourceLot.id);
    expect(updatedSourceLot?.remainingQuantity).toBe('30.000000');

    const adminDb = drizzle(adminClient, { schema });
    const destinationLotRows = await adminDb.select().from(lots).where(eq(lots.id, result.destinationLotId));
    const destinationLot = destinationLotRows[0];
    expect(destinationLot?.status).toBe('IN_TRANSIT');
    expect(destinationLot?.storeId).toBe(destinationStoreId);
    expect(destinationLot?.remainingQuantity).toBe('20.000000');
    // Carries across UNCHANGED — same cost and expiry as the source lot, per plan.md.
    expect(destinationLot?.unitCost).toBe('2.5000');
    expect(destinationLot?.expiryDate).toBe('2026-09-01');
  });

  it('an IN_TRANSIT destination lot is invisible to FEFO until the transfer is received', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId: sourceStoreId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '30.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });

    const service = new TransferService(createScopedDb(client), organizationId);
    await service.initiateTransfer({
      sourceStoreId,
      destinationStoreId,
      productId,
      variantId,
      quantity: '10.000000',
      unit: 'g',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    // The destination lot exists but is IN_TRANSIT — findFefoCandidates at the destination store
    // must not see it.
    const destinationLotRepo = new LotRepository(createScopedDb(client), organizationId);
    const candidates = await destinationLotRepo.findFefoCandidates(destinationStoreId, productId);
    expect(candidates).toHaveLength(0);
  });

  it('receiveTransfer posts TRANSFER_IN at the destination and flips the destination lot ACTIVE, making it FEFO-eligible', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId: sourceStoreId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '30.000000',
      unitCost: '1.5000',
      currency: 'USD',
    });

    const service = new TransferService(createScopedDb(client), organizationId);
    const initiated = await service.initiateTransfer({
      sourceStoreId,
      destinationStoreId,
      productId,
      variantId,
      quantity: '15.000000',
      unit: 'g',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const received = await service.receiveTransfer(initiated.transfer.id, userId);
    expect(received.status).toBe('RECEIVED');
    expect(received.receivedByUserId).toBe(userId);

    const adminDb = drizzle(adminClient, { schema });
    const destinationLotRows = await adminDb.select().from(lots).where(eq(lots.id, initiated.destinationLotId));
    expect(destinationLotRows[0]?.status).toBe('ACTIVE');

    const movements = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    const inMovement = movements.find((m) => m.movementType === 'TRANSFER_IN');
    expect(inMovement?.quantity).toBe('15.000000');
    expect(inMovement?.storeId).toBe(destinationStoreId);

    // Now genuinely FEFO-eligible at the destination.
    const candidates = await new LotRepository(createScopedDb(client), organizationId).findFefoCandidates(destinationStoreId, productId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(initiated.destinationLotId);
  });

  it('cancelTransfer reverses the source draw (compensating movement, never an UPDATE) and marks the destination lot DEPLETED, never ACTIVE', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    const sourceLot = await lotRepo.receive({
      id: generateId(),
      storeId: sourceStoreId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '40.000000',
      unitCost: '2.0000',
      currency: 'USD',
    });

    const service = new TransferService(createScopedDb(client), organizationId);
    const initiated = await service.initiateTransfer({
      sourceStoreId,
      destinationStoreId,
      productId,
      variantId,
      quantity: '10.000000',
      unit: 'g',
      occurredAt: new Date(),
      sourceType: 'manual',
    });

    const cancelled = await service.cancelTransfer(initiated.transfer.id, userId);
    expect(cancelled.status).toBe('CANCELLED');

    const updatedSourceLot = await lotRepo.findById(sourceLot.id);
    expect(updatedSourceLot?.remainingQuantity).toBe('40.000000');
    expect(updatedSourceLot?.status).toBe('ACTIVE');

    const adminDb = drizzle(adminClient, { schema });
    const destinationLotRows = await adminDb.select().from(lots).where(eq(lots.id, initiated.destinationLotId));
    expect(destinationLotRows[0]?.status).toBe('DEPLETED');

    // The original TRANSFER_OUT row is untouched (I3 — never UPDATE/DELETE); the reversal is a
    // SEPARATE compensating TRANSFER_IN row.
    const movements = await adminDb.select().from(stockMovements).where(eq(stockMovements.organizationId, organizationId));
    expect(movements.filter((m) => m.movementType === 'TRANSFER_OUT')).toHaveLength(1);
    expect(movements.filter((m) => m.movementType === 'TRANSFER_IN')).toHaveLength(1);
  });

  it('throws InsufficientStockError rather than posting a partial transfer', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId: sourceStoreId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '5.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });

    const service = new TransferService(createScopedDb(client), organizationId);
    await expect(
      service.initiateTransfer({
        sourceStoreId,
        destinationStoreId,
        productId,
        variantId,
        quantity: '50.000000',
        unit: 'g',
        occurredAt: new Date(),
        sourceType: 'manual',
      })
    ).rejects.toThrow(InsufficientStockError);

    const adminDb = drizzle(adminClient, { schema });
    const transfers = await adminDb.select().from(stockTransfers).where(eq(stockTransfers.organizationId, organizationId));
    expect(transfers).toHaveLength(0);
  });

  it('rejects invalid state transitions with a typed error (receiving an already-RECEIVED transfer)', async () => {
    const lotRepo = new LotRepository(createScopedDb(client), organizationId);
    await lotRepo.receive({
      id: generateId(),
      storeId: sourceStoreId,
      productId,
      variantId,
      receivedAt: new Date(),
      initialQuantity: '20.000000',
      unitCost: '1.0000',
      currency: 'USD',
    });

    const service = new TransferService(createScopedDb(client), organizationId);
    const initiated = await service.initiateTransfer({
      sourceStoreId,
      destinationStoreId,
      productId,
      variantId,
      quantity: '5.000000',
      unit: 'g',
      occurredAt: new Date(),
      sourceType: 'manual',
    });
    await service.receiveTransfer(initiated.transfer.id, userId);

    await expect(service.receiveTransfer(initiated.transfer.id, userId)).rejects.toThrow(InvalidTransferTransitionError);
    await expect(service.cancelTransfer(initiated.transfer.id, userId)).rejects.toThrow(InvalidTransferTransitionError);
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new TransferService(createScopedDb(client), '')).toThrow();
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;
    let productAId: string;
    let variantAId: string;
    let secondStoreAId: string;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
      const adminDb = drizzle(adminClient, { schema });

      secondStoreAId = generateId();
      await adminDb.insert(stores).values({
        id: secondStoreAId,
        organizationId: fixture.tenantA.organizationId,
        name: 'Tenant A Second Store',
        timezone: 'America/New_York',
      });

      const repoA = new ProductRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const productA = await repoA.create({
        id: generateId(),
        sku: `SKU-CT-${generateId()}`,
        name: 'Cross Tenant Flour',
        baseUnitId: unitId,
        type: 'INGREDIENT',
      });
      productAId = productA.id;
      variantAId = (await repoA.findVariants(productAId))[0]!.id;
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(stockTransfers).where(eq(stockTransfers.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(auditLogs).where(eq(auditLogs.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(outboxEvents).where(eq(outboxEvents.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(stockLevels).where(eq(stockLevels.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(stockMovements).where(eq(stockMovements.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(lots).where(eq(lots.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(productVariants).where(eq(productVariants.productId, productAId));
      await adminDb.delete(products).where(eq(products.id, productAId));
      await adminDb.delete(stores).where(eq(stores.id, secondStoreAId));
      await fixture.cleanup();
    });

    it('tenant B cannot read or act on tenant A\'s transfer', async () => {
      const lotRepoA = new LotRepository(createScopedDb(client), fixture.tenantA.organizationId);
      await lotRepoA.receive({
        id: generateId(),
        storeId: fixture.tenantA.storeId,
        productId: productAId,
        variantId: variantAId,
        receivedAt: new Date(),
        initialQuantity: '20.000000',
        unitCost: '1.0000',
        currency: 'USD',
      });

      const serviceA = new TransferService(createScopedDb(client), fixture.tenantA.organizationId);
      const initiated = await serviceA.initiateTransfer({
        sourceStoreId: fixture.tenantA.storeId,
        destinationStoreId: secondStoreAId,
        productId: productAId,
        variantId: variantAId,
        quantity: '5.000000',
        unit: 'g',
        occurredAt: new Date(),
        sourceType: 'manual',
      });

      const serviceB = new TransferService(createScopedDb(client), fixture.tenantB.organizationId);
      const foundByB = await serviceB.findById(initiated.transfer.id);
      expect(foundByB).toBeNull();

      await expect(serviceB.receiveTransfer(initiated.transfer.id, userId)).rejects.toThrow();

      const stillInTransit = await serviceA.findById(initiated.transfer.id);
      expect(stillInTransit?.status).toBe('IN_TRANSIT');
    });
  });
});
