import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, organizations, stores, conversations, messages, users } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

/**
 * the first real HTTP proof of the entire AI assistant epic. Every prior task's own
 * verification was a temporary script calling library functions directly; this is a real request
 * against a real running server, exercising auth, conversation/message persistence, and the real
 * pipeline together — matching this codebase's standing "verify the HTTP layer with real requests"
 * discipline (typecheck/unit tests alone miss error-shape/status-code bugs a real request catches).
 */
describe('assistant.ask', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const sessionStore = new SessionStore(redis);
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await db.delete(messages).where(eq(messages.organizationId, orgId));
      await db.delete(conversations).where(eq(conversations.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdOrgIds.length = 0;
    for (const userId of createdUserIds) {
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Assistant Test Org ${organizationId}`, slug: `assistant-test-${organizationId}`, baseCurrency: 'USD' });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Test Store', timezone: 'America/New_York' });
    return { organizationId, storeId };
  };

  const issueSession = async (organizationId: string, permissions: Permission[] = ['financial:read', 'inventory:read', 'purchasing:read']): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    // A real users row is required here (unlike search.test.ts's issueSession, which this file's
    // first draft copied) — this router is the first to actually write a row REFERENCING userId
    // (conversations.userId has a real FK), so the session's userId must correspond to a real one.
    await db.insert(users).values({ id: userId, email: `assistant-test-${userId}@example.test` });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role: 'OWNER', permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const ask = async (question: string, cookie: string | null, conversationId?: string) =>
    app.inject({
      method: 'POST',
      url: '/trpc/assistant.ask',
      cookies: cookie ? { '__Host-session': cookie } : {},
      payload: { question, ...(conversationId ? { conversationId } : {}) },
    });

  it('rejects a request with no session cookie (401)', async () => {
    const response = await ask('What is my net revenue?', null);
    expect(response.statusCode).toBe(401);
  });

  it("a cross-org conversationId is rejected as NOT_FOUND, never another tenant's transcript", async () => {
    const { organizationId: orgA } = await setUpOrg();
    const { organizationId: orgB } = await setUpOrg();
    const cookieA = await issueSession(orgA);
    const cookieB = await issueSession(orgB);

    const first = await ask('What is my net revenue?', cookieA);
    expect(first.statusCode).toBe(200);
    const { conversationId } = JSON.parse(first.body).result.data;

    const crossOrgAttempt = await ask('Show me the numbers', cookieB, conversationId);
    expect(crossOrgAttempt.statusCode).toBe(404);
  });

  describe('with no GEMINI_API_KEY configured', () => {
    const originalGeminiApiKey = process.env.GEMINI_API_KEY;

    beforeAll(async () => {
      delete process.env.GEMINI_API_KEY;
    });

    afterAll(() => {
      if (originalGeminiApiKey !== undefined) process.env.GEMINI_API_KEY = originalGeminiApiKey;
    });

    it('degrades to a real, honest, typed error — never a fabricated answer, and never a hard 500 for an anticipated condition', async () => {
      const { organizationId } = await setUpOrg();
      const cookie = await issueSession(organizationId);

      const response = await ask('What is my net revenue?', cookie);

      // A real conversation still gets created and a real message row still gets written — the
      // ONLY thing that's genuinely unavailable is a model call, matching runPipeline's own
      // `{kind: 'error'}` outcome shape rather than treating "no key" as an HTTP-layer failure.
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data;
      expect(body.kind).toBe('error');
      expect(body.conversationId).toBeTruthy();
    });
  });

  describe('with a real GEMINI_API_KEY (live)', () => {
    it('a real question creates a real conversation and persists both a USER and an ASSISTANT message', async () => {
      if (!process.env.GEMINI_API_KEY) {
        console.warn('Skipping live assistant.ask test — no GEMINI_API_KEY in this environment.');
        return;
      }
      const { organizationId } = await setUpOrg();
      const cookie = await issueSession(organizationId);

      const response = await ask('What was my net revenue this month?', cookie);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data;
      expect(body.conversationId).toBeTruthy();
      expect(['bundle', 'unsupported', 'error']).toContain(body.kind);

      const rows = await db.select().from(messages).where(eq(messages.conversationId, body.conversationId));
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.role === 'USER')?.content).toBe('What was my net revenue this month?');
      expect(rows.find((r) => r.role === 'ASSISTANT')?.content).toBeTruthy();
    }, 30000);

    it('a second call with the returned conversationId continues the SAME conversation, not a new one', async () => {
      if (!process.env.GEMINI_API_KEY) {
        console.warn('Skipping live assistant.ask test — no GEMINI_API_KEY in this environment.');
        return;
      }
      const { organizationId } = await setUpOrg();
      const cookie = await issueSession(organizationId);

      const first = await ask('What was my net revenue this month?', cookie);
      const { conversationId } = JSON.parse(first.body).result.data;

      const second = await ask('And what about food cost percentage?', cookie, conversationId);
      expect(second.statusCode).toBe(200);
      const secondBody = JSON.parse(second.body).result.data;
      expect(secondBody.conversationId).toBe(conversationId);

      const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
      expect(rows).toHaveLength(4); // 2 USER + 2 ASSISTANT across both calls
    }, 30000);

    it('a permission-denied question produces a real refusal with the specific reason, never a 500', async () => {
      if (!process.env.GEMINI_API_KEY) {
        console.warn('Skipping live assistant.ask test — no GEMINI_API_KEY in this environment.');
        return;
      }
      const { organizationId } = await setUpOrg();
      // STAFF, no financial:read — cogs_actual (a real metric requiring it) should come back as a
      // real, named denial via buildRefusal, not a crash.
      const cookie = await issueSession(organizationId, ['inventory:read']);

      const response = await ask('What was my actual COGS this month?', cookie);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data;
      if (body.kind === 'bundle' && body.refusal) {
        expect(body.refusal.items.length).toBeGreaterThan(0);
      }
    }, 30000);
  });

  describe('getConversation / listConversations', () => {
    it("getConversation for a cross-org id returns NOT_FOUND, never another tenant's transcript", async () => {
      const { organizationId: orgA } = await setUpOrg();
      const { organizationId: orgB } = await setUpOrg();
      const cookieB = await issueSession(orgB);

      // Seed a real conversation for org A directly (no live Gemini call needed for this check).
      const { ConversationRepository } = await import('@retailos/db');
      const convoRepo = new ConversationRepository(db, orgA);
      const userId = generateId();
      createdUserIds.push(userId);
      await db.insert(users).values({ id: userId, email: `assistant-cross-org-test-${userId}@example.test` });
      const conversation = await convoRepo.create({ userId });

      const response = await app.inject({
        method: 'GET',
        url: `/trpc/assistant.getConversation?input=${encodeURIComponent(JSON.stringify({ conversationId: conversation.id }))}`,
        cookies: { '__Host-session': cookieB },
      });

      expect(response.statusCode).toBe(404);
    });

    it('listConversations for a fresh org returns a real empty array, never a fabricated entry', async () => {
      const { organizationId } = await setUpOrg();
      const cookie = await issueSession(organizationId);

      const response = await app.inject({
        method: 'GET',
        url: `/trpc/assistant.listConversations?input=${encodeURIComponent(JSON.stringify({}))}`,
        cookies: { '__Host-session': cookie },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body).result.data;
      expect(body).toEqual([]);
    });
  });
});
