import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { conversations } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { ConversationRepository } from './conversation-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('ConversationRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let fixture: TwoTenantFixture;

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(conversations).where(eq(conversations.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(conversations).where(eq(conversations.organizationId, fixture.tenantB.organizationId));
    await client.end();
    await fixture.cleanup();
  });

  it('create writes a real row, findById reads it back, findForUser lists it', async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);

    const db = createScopedDb(client);
    const repo = new ConversationRepository(db, fixture.tenantA.organizationId);

    const { id } = await repo.create({ userId: fixture.tenantA.userId, title: 'What is my food cost?' });

    const found = await repo.findById(id);
    expect(found?.id).toBe(id);
    expect(found?.title).toBe('What is my food cost?');
    expect(found?.userId).toBe(fixture.tenantA.userId);

    const list = await repo.findForUser(fixture.tenantA.userId);
    expect(list.map((c) => c.id)).toContain(id);
  });

  it('a title-less conversation is a real, valid row — title is optional, never a fabricated placeholder', async () => {
    const db = createScopedDb(client);
    const repo = new ConversationRepository(db, fixture.tenantA.organizationId);

    const { id } = await repo.create({ userId: fixture.tenantA.userId });
    const found = await repo.findById(id);

    expect(found?.title).toBeNull();
  });

  it('a cross-tenant conversation is genuinely invisible, not just filtered client-side', async () => {
    const dbA = createScopedDb(client);
    const repoA = new ConversationRepository(dbA, fixture.tenantA.organizationId);
    const { id } = await repoA.create({ userId: fixture.tenantA.userId, title: 'Tenant A only' });

    const repoB = new ConversationRepository(dbA, fixture.tenantB.organizationId);
    const found = await repoB.findById(id);

    expect(found).toBeNull();
  });
});
