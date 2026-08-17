import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index';
import { conversations, messages } from '../schema/index';
import { createScopedDb } from '../tenant-repository';
import { ConversationRepository } from './conversation-repository';
import { MessageRepository } from './message-repository';
import { setUpTwoTenants, type TwoTenantFixture } from '../test-support/tenant-fixture';

const APP_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';
const ADMIN_CONNECTION_STRING =
  process.env.TEST_DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/retailos';

describe('MessageRepository', () => {
  let client: ReturnType<typeof postgres>;
  let adminClient: ReturnType<typeof postgres>;
  let fixture: TwoTenantFixture;
  let conversationId: string;

  afterAll(async () => {
    const adminDb = drizzle(adminClient, { schema });
    await adminDb.delete(messages).where(eq(messages.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(messages).where(eq(messages.organizationId, fixture.tenantB.organizationId));
    await adminDb.delete(conversations).where(eq(conversations.organizationId, fixture.tenantA.organizationId));
    await adminDb.delete(conversations).where(eq(conversations.organizationId, fixture.tenantB.organizationId));
    await client.end();
    await fixture.cleanup();
  });

  it('create writes a real USER message with no grounding bundle', async () => {
    fixture = await setUpTwoTenants();
    client = postgres(APP_CONNECTION_STRING);
    adminClient = postgres(ADMIN_CONNECTION_STRING);

    const db = createScopedDb(client);
    const convoRepo = new ConversationRepository(db, fixture.tenantA.organizationId);
    const { id: convId } = await convoRepo.create({ userId: fixture.tenantA.userId });
    conversationId = convId;

    const repo = new MessageRepository(db, fixture.tenantA.organizationId);
    const { id } = await repo.create({
      conversationId,
      role: 'USER',
      content: 'What is my food cost this month?',
    });

    const list = await repo.findForConversation(conversationId);
    const found = list.find((m) => m.id === id);
    expect(found?.role).toBe('USER');
    expect(found?.groundingBundle).toBeNull();
  });

  it('create writes a real ASSISTANT message carrying a grounding bundle + validation result', async () => {
    const db = createScopedDb(client);
    const repo = new MessageRepository(db, fixture.tenantA.organizationId);

    const bundle = {
      metrics: [{ metricId: 'food_cost_percentage', value: '28.4', unit: 'PERCENTAGE' }],
      passages: [],
      entities: [],
    };
    const validation = { ok: true, violations: [] };

    const { id } = await repo.create({
      conversationId,
      role: 'ASSISTANT',
      content: 'Your food cost is 28.4% this month.',
      groundingBundle: bundle,
      modelVersion: 'gemini-flash-latest',
      promptVersion: 'v1',
      catalogVersion: 'v1',
      validationResult: validation,
    });

    const list = await repo.findForConversation(conversationId);
    const found = list.find((m) => m.id === id);
    expect(found?.role).toBe('ASSISTANT');
    expect(found?.groundingBundle).toEqual(bundle);
    expect(found?.validationResult).toEqual(validation);
    expect(found?.modelVersion).toBe('gemini-flash-latest');
  });

  it('findForConversation returns messages oldest-first — a transcript reads chronologically', async () => {
    const db = createScopedDb(client);
    const repo = new MessageRepository(db, fixture.tenantA.organizationId);

    const list = await repo.findForConversation(conversationId);
    const timestamps = list.map((m) => m.createdAt.getTime());
    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);
  });

  it('a cross-tenant message is genuinely invisible, not just filtered client-side', async () => {
    const dbA = createScopedDb(client);
    const repoB = new MessageRepository(dbA, fixture.tenantB.organizationId);

    const list = await repoB.findForConversation(conversationId);
    expect(list).toEqual([]);
  });
});
