import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { organizations, catalogCsvImports, savedCatalogCsvColumnMappings } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { CatalogCsvImportRepository, SavedCatalogCsvMappingRepository } from './catalog-csv-import-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('CatalogCsvImportRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Catalog CSV Import Test Org',
      slug: `catalog-csv-import-test-${organizationId}`,
      baseCurrency: 'USD',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(savedCatalogCsvColumnMappings).where(eq(savedCatalogCsvColumnMappings.organizationId, organizationId));
    await adminDb.delete(catalogCsvImports).where(eq(catalogCsvImports.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('create inserts a new import row as UPLOADED', async () => {
    const repo = new CatalogCsvImportRepository(createScopedDb(client), organizationId);
    const row = await repo.create({ importType: 'PRODUCT', storageKey: 'org/x/catalog-csv-imports/a.csv' });
    expect(row.status).toBe('UPLOADED');
    expect(row.importType).toBe('PRODUCT');
    expect(row.storageKey).toBe('org/x/catalog-csv-imports/a.csv');
    expect(row.detectedHeaders).toBeNull();
    expect(row.columnMapping).toBeNull();
  });

  it('recordDetectedHeaders records the detected shape without changing status', async () => {
    const repo = new CatalogCsvImportRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ importType: 'PRODUCT', storageKey: 'org/x/catalog-csv-imports/a.csv' });
    const updated = await repo.recordDetectedHeaders(created.id, {
      headers: ['sku', 'name'],
      sampleRows: [['SKU-1', 'Flour']],
      delimiter: ',',
    });
    expect(updated?.status).toBe('UPLOADED');
    expect(updated?.detectedHeaders).toEqual({ headers: ['sku', 'name'], sampleRows: [['SKU-1', 'Flour']], delimiter: ',' });
  });

  it('recordColumnMapping moves the row to MAPPED and stores the mapping', async () => {
    const repo = new CatalogCsvImportRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ importType: 'SUPPLIER', storageKey: 'org/x/catalog-csv-imports/a.csv' });
    const mapping = { name: 'supplier_name' };
    const updated = await repo.recordColumnMapping(created.id, mapping);
    expect(updated?.status).toBe('MAPPED');
    expect(updated?.columnMapping).toEqual(mapping);
  });

  it('recordImportResult moves the row to IMPORTED with row counts', async () => {
    const repo = new CatalogCsvImportRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ importType: 'PRODUCT', storageKey: 'org/x/catalog-csv-imports/a.csv' });
    const updated = await repo.recordImportResult(created.id, { totalRowCount: 10, importedRowCount: 8, skippedRowCount: 2 });
    expect(updated?.status).toBe('IMPORTED');
    expect(updated?.totalRowCount).toBe(10);
    expect(updated?.importedRowCount).toBe(8);
    expect(updated?.skippedRowCount).toBe(2);
  });

  it('recordFailure moves the row to FAILED with an error summary', async () => {
    const repo = new CatalogCsvImportRepository(createScopedDb(client), organizationId);
    const created = await repo.create({ importType: 'PRODUCT', storageKey: 'org/x/catalog-csv-imports/a.csv' });
    const updated = await repo.recordFailure(created.id, 'column mapping references a header that does not exist');
    expect(updated?.status).toBe('FAILED');
    expect(updated?.errorSummary).toBe('column mapping references a header that does not exist');
  });

  it('findAllForOrganization filters by importType when given', async () => {
    const repo = new CatalogCsvImportRepository(createScopedDb(client), organizationId);
    await repo.create({ importType: 'PRODUCT', storageKey: 'org/x/catalog-csv-imports/a.csv' });
    await repo.create({ importType: 'SUPPLIER', storageKey: 'org/x/catalog-csv-imports/b.csv' });

    const all = await repo.findAllForOrganization();
    expect(all).toHaveLength(2);

    const productsOnly = await repo.findAllForOrganization('PRODUCT');
    expect(productsOnly).toHaveLength(1);
    expect(productsOnly[0]?.importType).toBe('PRODUCT');
  });

  describe('cross-tenant', () => {
    let fixture: TwoTenantFixture;

    beforeAll(async () => {
      fixture = await setUpTwoTenants();
    });

    afterAll(async () => {
      const adminDb = drizzle(adminClient, { schema });
      await adminDb.delete(catalogCsvImports).where(eq(catalogCsvImports.organizationId, fixture.tenantA.organizationId));
      await adminDb.delete(catalogCsvImports).where(eq(catalogCsvImports.organizationId, fixture.tenantB.organizationId));
      await fixture.cleanup();
    });

    it('tenant B cannot see tenant A catalog csv import by id', async () => {
      const repoA = new CatalogCsvImportRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.create({ importType: 'PRODUCT', storageKey: 'org/a/catalog-csv-imports/x.csv' });

      const repoB = new CatalogCsvImportRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const seenByB = await repoB.findById(created.id);
      expect(seenByB).toBeNull();
    });

    it('tenant B cannot record a column mapping onto tenant A row by id', async () => {
      const repoA = new CatalogCsvImportRepository(createScopedDb(client), fixture.tenantA.organizationId);
      const created = await repoA.create({ importType: 'PRODUCT', storageKey: 'org/a/catalog-csv-imports/x.csv' });

      const repoB = new CatalogCsvImportRepository(createScopedDb(client), fixture.tenantB.organizationId);
      const result = await repoB.recordColumnMapping(created.id, { sku: 's', name: 'n', unit: 'u', type: 't' });
      expect(result).toBeNull();

      const stillOwn = await repoA.findById(created.id);
      expect(stillOwn?.status).toBe('UPLOADED');
    });
  });

  it('constructor throws without an organizationId', () => {
    expect(() => new CatalogCsvImportRepository(createScopedDb(client), '')).toThrow();
  });
});

describe('SavedCatalogCsvMappingRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let organizationId: string;

  beforeAll(async () => {
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);
    const adminDb = drizzle(adminClient, { schema });

    organizationId = generateId();
    await adminDb.insert(organizations).values({
      id: organizationId,
      name: 'Saved Catalog Mapping Test Org',
      slug: `saved-catalog-mapping-test-${organizationId}`,
      baseCurrency: 'USD',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(savedCatalogCsvColumnMappings).where(eq(savedCatalogCsvColumnMappings.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('upsert creates then updates a mapping under the same (importType, label)', async () => {
    const repo = new SavedCatalogCsvMappingRepository(createScopedDb(client), organizationId);
    const first = await repo.upsert('PRODUCT', 'My export', { sku: 'sku', name: 'name', unit: 'unit', type: 'type' });
    const second = await repo.upsert('PRODUCT', 'My export', { sku: 'SKU', name: 'Name', unit: 'Unit', type: 'Type' });
    expect(second.id).toBe(first.id);
    expect(second.columnMapping).toEqual({ sku: 'SKU', name: 'Name', unit: 'Unit', type: 'Type' });
  });

  it('the SAME label is independent per importType — a product mapping and a supplier mapping both named "Main export" do not collide', async () => {
    const repo = new SavedCatalogCsvMappingRepository(createScopedDb(client), organizationId);
    const productMapping = await repo.upsert('PRODUCT', 'Main export', { sku: 'sku', name: 'name', unit: 'unit', type: 'type' });
    const supplierMapping = await repo.upsert('SUPPLIER', 'Main export', { name: 'name' });
    expect(productMapping.id).not.toBe(supplierMapping.id);

    const productOnly = await repo.findAllForOrganization('PRODUCT');
    expect(productOnly).toHaveLength(1);
    const supplierOnly = await repo.findAllForOrganization('SUPPLIER');
    expect(supplierOnly).toHaveLength(1);
  });

  it('findByLabel scopes by importType', async () => {
    const repo = new SavedCatalogCsvMappingRepository(createScopedDb(client), organizationId);
    await repo.upsert('SUPPLIER', 'Weekly', { name: 'name' });
    const found = await repo.findByLabel('SUPPLIER', 'Weekly');
    expect(found).not.toBeNull();
    const notFoundForProduct = await repo.findByLabel('PRODUCT', 'Weekly');
    expect(notFoundForProduct).toBeNull();
  });
});
