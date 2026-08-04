import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, salesTransactionLines, salesTransactions, stores } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SalesTransactionRepository } from './sales-transaction-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SalesTransactionRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;
  let storeId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Sales Test Org',
      slug: `sales-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    storeId = generateId();
    await adminDb.insert(stores).values({
      id: storeId,
      organizationId,
      name: 'Main Store',
      timezone: 'America/New_York',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, organizationId));
    await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('recordIfNew inserts a transaction and its lines together', async () => {
    const repo = new SalesTransactionRepository(createScopedDb(client), organizationId);
    const result = await repo.recordIfNew({
      storeId,
      source: 'square',
      externalId: 'SQ-ORDER-1',
      occurredAt: new Date('2026-01-05T12:00:00Z'),
      subtotal: '10.00',
      discount: '0.00',
      tax: '0.80',
      total: '10.80',
      currency: 'USD',
      lines: [
        { quantity: '2', unitPrice: '5.00', discount: '0.00', lineTotal: '10.00' },
      ],
    });

    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') throw new Error('expected recorded');

    const lines = await repo.findLines(result.transactionId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.lineTotal).toBe('10.0000');
  });

  it('recordIfNew is idempotent on (organization, source, external_id) — a re-run does not double-count', async () => {
    const repo = new SalesTransactionRepository(createScopedDb(client), organizationId);
    const first = await repo.recordIfNew({
      storeId,
      source: 'square',
      externalId: 'SQ-ORDER-DUP',
      occurredAt: new Date('2026-01-05T12:00:00Z'),
      subtotal: '10.00',
      discount: '0.00',
      tax: '0.80',
      total: '10.80',
      currency: 'USD',
      lines: [{ quantity: '1', unitPrice: '10.00', discount: '0.00', lineTotal: '10.00' }],
    });
    expect(first.status).toBe('recorded');

    const second = await repo.recordIfNew({
      storeId,
      source: 'square',
      externalId: 'SQ-ORDER-DUP',
      occurredAt: new Date('2026-01-05T12:00:00Z'),
      subtotal: '10.00',
      discount: '0.00',
      tax: '0.80',
      total: '10.80',
      currency: 'USD',
      lines: [{ quantity: '1', unitPrice: '10.00', discount: '0.00', lineTotal: '10.00' }],
    });
    expect(second.status).toBe('duplicate');

    if (first.status !== 'recorded') throw new Error('expected recorded');
    const lines = await repo.findLines(first.transactionId);
    expect(lines).toHaveLength(1);
  });

  it('the same external_id from a different source is a distinct transaction, not a duplicate', async () => {
    const repo = new SalesTransactionRepository(createScopedDb(client), organizationId);
    const square = await repo.recordIfNew({
      storeId,
      source: 'square',
      externalId: 'SAME-ID',
      occurredAt: new Date(),
      subtotal: '1.00',
      discount: '0.00',
      tax: '0.00',
      total: '1.00',
      currency: 'USD',
      lines: [],
    });
    const csv = await repo.recordIfNew({
      storeId,
      source: 'csv',
      externalId: 'SAME-ID',
      occurredAt: new Date(),
      subtotal: '1.00',
      discount: '0.00',
      tax: '0.00',
      total: '1.00',
      currency: 'USD',
      lines: [],
    });

    expect(square.status).toBe('recorded');
    expect(csv.status).toBe('recorded');
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, fixture.tenantB.organizationId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(salesTransactions).where(eq(salesTransactions.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A transactions by id', async () => {
      const repoA = new SalesTransactionRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.recordIfNew({
        storeId: fixture.tenantA.storeId,
        source: 'square',
        externalId: 'CROSS-TENANT-1',
        occurredAt: new Date(),
        subtotal: '1.00',
        discount: '0.00',
        tax: '0.00',
        total: '1.00',
        currency: 'USD',
        lines: [],
      });
      if (created.status !== 'recorded') throw new Error('expected recorded');

      const repoB = new SalesTransactionRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const seenByB = await repoB.findById(created.transactionId);
      expect(seenByB).toBeNull();
    });

    it('the same (source, external_id) in two different tenants are independent, non-colliding transactions', async () => {
      const repoA = new SalesTransactionRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const repoB = new SalesTransactionRepository(createScopedDb(client), fixture.tenantB.organizationId);

      const resultA = await repoA.recordIfNew({
        storeId: fixture.tenantA.storeId,
        source: 'square',
        externalId: 'SHARED-EXTERNAL-ID',
        occurredAt: new Date(),
        subtotal: '1.00',
        discount: '0.00',
        tax: '0.00',
        total: '1.00',
        currency: 'USD',
        lines: [],
      });
      const resultB = await repoB.recordIfNew({
        storeId: fixture.tenantB.storeId,
        source: 'square',
        externalId: 'SHARED-EXTERNAL-ID',
        occurredAt: new Date(),
        subtotal: '1.00',
        discount: '0.00',
        tax: '0.00',
        total: '1.00',
        currency: 'USD',
        lines: [],
      });

      expect(resultA.status).toBe('recorded');
      expect(resultB.status).toBe('recorded');
    });
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new SalesTransactionRepository(createScopedDb(client), '')).toThrow();
  });
});
