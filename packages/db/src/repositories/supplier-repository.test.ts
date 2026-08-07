import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { organizations, suppliers } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { SupplierRepository } from './supplier-repository';
import { generateId } from '@retailos/domain';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('SupplierRepository', () => {
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
      name: 'Supplier Test Org',
      slug: `supplier-test-${organizationId}`,
      baseCurrency: 'USD',
    });
  });

  afterEach(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(suppliers).where(eq(suppliers.organizationId, organizationId));
  });

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(organizations).where(eq(organizations.id, organizationId));
    await client.end();
    await adminClient.end();
  });

  it('creates a supplier with lead time and MOQ', async () => {
    const repo = new SupplierRepository(createScopedDb(client), organizationId);
    const supplier = await repo.create({
      id: generateId(),
      name: 'Acme Foods',
      leadTimeDaysContracted: 3,
      minOrderValue: '500.0000',
    });

    expect(supplier.name).toBe('Acme Foods');
    expect(supplier.leadTimeDaysContracted).toBe(3);
    expect(supplier.leadTimeDaysMeasured).toBeNull();
    expect(supplier.status).toBe('active');
  });

  it('recordMeasuredLeadTime updates measured without touching contracted', async () => {
    const repo = new SupplierRepository(createScopedDb(client), organizationId);
    const supplier = await repo.create({ id: generateId(), name: 'Acme Foods', leadTimeDaysContracted: 3 });

    const updated = await repo.recordMeasuredLeadTime(supplier.id, 5);

    expect(updated?.leadTimeDaysContracted).toBe(3);
    expect(updated?.leadTimeDaysMeasured).toBe(5);
  });

  it('findAll excludes soft-deleted suppliers', async () => {
    const repo = new SupplierRepository(createScopedDb(client), organizationId);
    const supplier = await repo.create({ id: generateId(), name: 'Gone Supplier' });

    const adminDb = drizzle(adminClient, { schema });
    await adminDb.update(suppliers).set({ deletedAt: new Date() }).where(eq(suppliers.id, supplier.id));

    const all = await repo.findAll();
    expect(all.some((s) => s.id === supplier.id)).toBe(false);
  });

  it('findById returns null for a nonexistent supplier', async () => {
    const repo = new SupplierRepository(createScopedDb(client), organizationId);
    const result = await repo.findById(generateId());
    expect(result).toBeNull();
  });

  it('findByExactName matches case-insensitively', async () => {
    const repo = new SupplierRepository(createScopedDb(client), organizationId);
    const supplier = await repo.create({ id: generateId(), name: 'Coastal Meats & Poultry' });

    const found = await repo.findByExactName('coastal meats & poultry');
    expect(found?.id).toBe(supplier.id);
  });

  it('findByExactName returns null when no supplier matches', async () => {
    const repo = new SupplierRepository(createScopedDb(client), organizationId);
    const result = await repo.findByExactName('Nonexistent Supplier');
    expect(result).toBeNull();
  });

  it('findByExactName never fuzzy-matches a partial or near name', async () => {
    const repo = new SupplierRepository(createScopedDb(client), organizationId);
    await repo.create({ id: generateId(), name: 'Coastal Meats & Poultry' });

    const partial = await repo.findByExactName('Coastal Meats');
    expect(partial).toBeNull();
  });
});
