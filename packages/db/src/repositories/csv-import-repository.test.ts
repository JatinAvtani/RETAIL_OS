import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, salesCsvImports, stores } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { CsvImportRepository } from './csv-import-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('CsvImportRepository', () => {
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
      name: 'CSV Import Test Org',
      slug: `csv-import-test-${organizationId}`,
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
    await adminDb.delete(salesCsvImports).where(eq(salesCsvImports.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(stores).where(eq(stores.organizationId, organizationId));
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('create inserts a new import row as UPLOADED', async () => {
    const repo = new CsvImportRepository(createScopedDb(client), organizationId);
    const row = await repo.create({ storeId, storageKey: 'org/x/sales-csv-imports/a.csv' });
    expect(row.status).toBe('UPLOADED');
    expect(row.storageKey).toBe('org/x/sales-csv-imports/a.csv');
    expect(row.detectedHeaders).toBeNull();
    expect(row.columnMapping).toBeNull();
  });

  it('recordDetectedHeaders records the detected shape without changing status', async () => {
    const repo = new CsvImportRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, storageKey: 'org/x/sales-csv-imports/a.csv' });
    const updated = await repo.recordDetectedHeaders(created.id, {
      headers: ['date', 'item'],
      sampleRows: [['2026-08-01', 'Latte']],
      delimiter: ',',
    });
    expect(updated?.status).toBe('UPLOADED');
    expect(updated?.detectedHeaders).toEqual({ headers: ['date', 'item'], sampleRows: [['2026-08-01', 'Latte']], delimiter: ',' });
  });

  it('recordColumnMapping moves the row to MAPPED and stores the mapping', async () => {
    const repo = new CsvImportRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, storageKey: 'org/x/sales-csv-imports/a.csv' });
    const mapping = { occurredAt: 'date', posItemName: 'item', quantity: 'qty', unitPrice: 'price' };
    const updated = await repo.recordColumnMapping(created.id, mapping);
    expect(updated?.status).toBe('MAPPED');
    expect(updated?.columnMapping).toEqual(mapping);
  });

  it('recordImportResult moves the row to IMPORTED with row counts', async () => {
    const repo = new CsvImportRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, storageKey: 'org/x/sales-csv-imports/a.csv' });
    const updated = await repo.recordImportResult(created.id, {
      totalRowCount: 10,
      importedRowCount: 8,
      quarantinedRowCount: 1,
      skippedRowCount: 1,
    });
    expect(updated?.status).toBe('IMPORTED');
    expect(updated?.totalRowCount).toBe(10);
    expect(updated?.importedRowCount).toBe(8);
    expect(updated?.quarantinedRowCount).toBe(1);
    expect(updated?.skippedRowCount).toBe(1);
  });

  it('recordFailure moves the row to FAILED with an error summary', async () => {
    const repo = new CsvImportRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ storeId, storageKey: 'org/x/sales-csv-imports/a.csv' });
    const updated = await repo.recordFailure(created.id, 'column mapping references a header that does not exist');
    expect(updated?.status).toBe('FAILED');
    expect(updated?.errorSummary).toBe('column mapping references a header that does not exist');
  });

  it('findAllForOrganization returns every import for this org', async () => {
    const repo = new CsvImportRepository(createScopedDb(client), organizationId);
    await repo.create({ storeId, storageKey: 'org/x/sales-csv-imports/a.csv' });
    await repo.create({ storeId, storageKey: 'org/x/sales-csv-imports/b.csv' });
    const all = await repo.findAllForOrganization();
    expect(all).toHaveLength(2);
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(salesCsvImports).where(eq(salesCsvImports.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(salesCsvImports).where(eq(salesCsvImports.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A csv import by id', async () => {
      const repoA = new CsvImportRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.create({ storeId: fixture.tenantA.storeId, storageKey: 'org/a/sales-csv-imports/x.csv' });

      const repoB = new CsvImportRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const seenByB = await repoB.findById(created.id);
      expect(seenByB).toBeNull();
    });

    it('tenant B cannot record a column mapping onto tenant A row by id', async () => {
      const repoA = new CsvImportRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.create({ storeId: fixture.tenantA.storeId, storageKey: 'org/a/sales-csv-imports/x.csv' });

      const repoB = new CsvImportRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const result = await repoB.recordColumnMapping(created.id, { occurredAt: 'd', posItemName: 'i', quantity: 'q', unitPrice: 'p' });
      expect(result).toBeNull();

      const stillOwn = await repoA.findById(created.id);
      expect(stillOwn?.status).toBe('UPLOADED'); // untouched — tenant B's attempt was a real no-op, not a silent partial write
    });
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new CsvImportRepository(createScopedDb(client), '')).toThrow();
  });
});
