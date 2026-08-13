import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, stores, suppliers, supplierPerformanceEvents, products, units } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { withTenantContext } from '../tenant-context';
import { SupplierPerformanceEventRepository } from './supplier-performance-event-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SupplierPerformanceEventRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let supplierId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Supplier Performance Test Org',
      slug: `spe-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    await adminDb.insert(stores).values({ id: generateId(), organizationId, name: 'Main Store', timezone: 'America/New_York' });

    supplierId = generateId();
    await adminDb.insert(suppliers).values({ id: supplierId, organizationId, name: 'SPE Test Supplier' });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, organizationId));
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('recordInTx writes a real row, and findForSupplierSince reads it back', async () => {
    const db = createScopedDb(client);
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        SupplierPerformanceEventRepository.recordInTx(tx, organizationId, {
          organizationId,
          supplierId,
          eventType: 'DELIVERY_ON_TIME',
          occurredAt: new Date(),
        })
      )
    );

    const repo = new SupplierPerformanceEventRepository(db, organizationId);
    const events = await repo.findForSupplierSince(supplierId, new Date(Date.now() - 60_000));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('DELIVERY_ON_TIME');
    expect(events[0]?.expectedValue).toBeNull();
    expect(events[0]?.actualValue).toBeNull();
  });

  it('findForSupplierSince excludes events before the given date', async () => {
    const db = createScopedDb(client);
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, () =>
        SupplierPerformanceEventRepository.recordInTx(tx, organizationId, {
          organizationId,
          supplierId,
          eventType: 'DELIVERY_LATE',
          occurredAt: oldDate,
        })
      )
    );

    const repo = new SupplierPerformanceEventRepository(db, organizationId);
    const recentEvents = await repo.findForSupplierSince(supplierId, new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(recentEvents).toHaveLength(0);

    const allEvents = await repo.findForSupplierSince(supplierId, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    expect(allEvents).toHaveLength(1);
  });

  it('findForSupplierBetween (008-15) returns only events strictly within [since, until) — the real prior-window read the trend endpoint depends on', async () => {
    const db = createScopedDb(client);
    const now = Date.now();
    const insertAt = (occurredAt: Date) =>
      db.transaction((tx) =>
        withTenantContext(tx, organizationId, () =>
          SupplierPerformanceEventRepository.recordInTx(tx, organizationId, { organizationId, supplierId, eventType: 'DELIVERY_ON_TIME', occurredAt })
        )
      );

    await insertAt(new Date(now - 90 * 24 * 60 * 60 * 1000)); // before the window — excluded
    await insertAt(new Date(now - 45 * 24 * 60 * 60 * 1000)); // inside the window — included
    await insertAt(new Date(now - 5 * 24 * 60 * 60 * 1000)); // after the window (current window) — excluded

    const repo = new SupplierPerformanceEventRepository(db, organizationId);
    const events = await repo.findForSupplierBetween(supplierId, new Date(now - 60 * 24 * 60 * 60 * 1000), new Date(now - 30 * 24 * 60 * 60 * 1000));
    expect(events).toHaveLength(1);
    const diffMs = Math.abs(events[0]!.occurredAt.getTime() - (now - 45 * 24 * 60 * 60 * 1000));
    expect(diffMs).toBeLessThan(5000); // real DB round-trip precision, not an exact JS-timestamp match
  });

  it('findForSupplierAndProductSince narrows to one product', async () => {
    const adminDb = drizzle(adminClient, { schema });
    const [kg] = await adminDb.select().from(units).where(eq(units.code, 'kg'));
    const productIdA = generateId();
    const productIdB = generateId();
    await adminDb.insert(products).values([
      { id: productIdA, organizationId, sku: `SPE-A-${productIdA}`, name: 'SPE Test Product A', baseUnitId: kg!.id, type: 'INGREDIENT' },
      { id: productIdB, organizationId, sku: `SPE-B-${productIdB}`, name: 'SPE Test Product B', baseUnitId: kg!.id, type: 'INGREDIENT' },
    ]);

    const db = createScopedDb(client);
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await SupplierPerformanceEventRepository.recordInTx(tx, organizationId, {
          organizationId,
          supplierId,
          eventType: 'FILL_COMPLETE',
          productId: productIdA,
          occurredAt: new Date(),
        });
        await SupplierPerformanceEventRepository.recordInTx(tx, organizationId, {
          organizationId,
          supplierId,
          eventType: 'FILL_COMPLETE',
          productId: productIdB,
          occurredAt: new Date(),
        });
      })
    );

    const repo = new SupplierPerformanceEventRepository(db, organizationId);
    const events = await repo.findForSupplierAndProductSince(supplierId, productIdA, new Date(Date.now() - 60_000));
    expect(events).toHaveLength(1);
    expect(events[0]?.productId).toBe(productIdA);

    // Events (which reference these products) are cleaned up by afterEach; the products themselves
    // must be deleted here, before afterEach runs, so a later test's product insert never collides.
    await adminDb.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, organizationId));
    await adminDb.delete(products).where(eq(products.organizationId, organizationId));
  });

  it('countForSupplier returns the real count', async () => {
    const db = createScopedDb(client);
    await db.transaction((tx) =>
      withTenantContext(tx, organizationId, async () => {
        await SupplierPerformanceEventRepository.recordInTx(tx, organizationId, {
          organizationId,
          supplierId,
          eventType: 'INVOICE_CLEAN',
          occurredAt: new Date(),
        });
        await SupplierPerformanceEventRepository.recordInTx(tx, organizationId, {
          organizationId,
          supplierId,
          eventType: 'INVOICE_ERROR',
          occurredAt: new Date(),
        });
      })
    );

    const repo = new SupplierPerformanceEventRepository(db, organizationId);
    expect(await repo.countForSupplier(supplierId)).toBe(2);
  });

  describe('cross-tenant isolation (I4)', () => {
    let fixture: TwoTenantFixture | undefined;

    afterEach(async () => {
      await fixture?.cleanup();
    });

    it('an event recorded under tenant A is invisible to tenant B, proven via RLS not just an app-level filter', async () => {
      fixture = await setUpTwoTenants();
      const supplierIdA = generateId();
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.insert(suppliers).values({ id: supplierIdA, organizationId: fixture.tenantA.organizationId, name: 'Tenant A Supplier' });

      const db = createScopedDb(client);
      await db.transaction((tx) =>
        withTenantContext(tx, fixture!.tenantA.organizationId, () =>
          SupplierPerformanceEventRepository.recordInTx(tx, fixture!.tenantA.organizationId, {
            organizationId: fixture!.tenantA.organizationId,
            supplierId: supplierIdA,
            eventType: 'DELIVERY_ON_TIME',
            occurredAt: new Date(),
          })
        )
      );

      const repoB = new SupplierPerformanceEventRepository(db, fixture.tenantB.organizationId);
      const eventsFromB = await repoB.findForSupplierSince(supplierIdA, new Date(Date.now() - 60_000));
      expect(eventsFromB).toHaveLength(0);

      const repoA = new SupplierPerformanceEventRepository(db, fixture.tenantA.organizationId);
      const eventsFromA = await repoA.findForSupplierSince(supplierIdA, new Date(Date.now() - 60_000));
      expect(eventsFromA).toHaveLength(1);

      await adminDb.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(suppliers).where(eq(suppliers.id, supplierIdA));
    });
  });
});
