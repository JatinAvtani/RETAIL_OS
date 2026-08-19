import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, memberships, organizations, users } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('settings — getMatchTolerances/updateMatchTolerances', () => {
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
      await db.delete(memberships).where(eq(memberships.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    for (const userId of createdUserIds) {
      await db.delete(users).where(eq(users.id, userId));
    }
    createdOrgIds.length = 0;
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const call = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/trpc/${path}`, cookies: { '__Host-session': cookie }, payload: input });

  const query = async (path: string, cookie: string) =>
    app.inject({ method: 'GET', url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify({}))}`, cookies: { '__Host-session': cookie } });

  const issueSession = async (organizationId: string, role: 'OWNER' | 'MANAGER', permissions: Permission[]): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `settings-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role, permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Settings Test Org ${organizationId}`, slug: `settings-test-${organizationId}`, baseCurrency: 'USD' });
    return organizationId;
  };

  it('getMatchTolerances returns null for every field on a fresh org — no fabricated defaults stored', async () => {
    const organizationId = await setUpOrg();
    const token = await issueSession(organizationId, 'OWNER', ['settings:manage']);

    const response = await query('settings.getMatchTolerances', token);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.matchPriceTolerancePercent).toBeNull();
    expect(body.matchPriceToleranceAbsolute).toBeNull();
    expect(body.matchQuantityTolerancePercent).toBeNull();
  });

  it('updateMatchTolerances writes a real value an OWNER can then read back', async () => {
    const organizationId = await setUpOrg();
    const token = await issueSession(organizationId, 'OWNER', ['settings:manage']);

    const update = await call('settings.updateMatchTolerances', token, { matchPriceTolerancePercent: '0.0500', matchPriceToleranceAbsolute: '25.0000' });
    expect(update.statusCode).toBe(200);
    const updateBody = JSON.parse(update.body).result.data;
    expect(updateBody.matchPriceTolerancePercent).toBe('0.0500');
    expect(updateBody.matchPriceToleranceAbsolute).toBe('25.0000');
    expect(updateBody.matchQuantityTolerancePercent).toBeNull();

    const readBack = await query('settings.getMatchTolerances', token);
    const readBody = JSON.parse(readBack.body).result.data;
    expect(readBody.matchPriceTolerancePercent).toBe('0.0500');
  });

  it('a real MANAGER session (settings:manage NOT granted) gets 403 on both endpoints', async () => {
    const organizationId = await setUpOrg();
    const managerToken = await issueSession(organizationId, 'MANAGER', ['purchasing:read', 'purchasing:write', 'purchasing:approve']);

    const getResponse = await query('settings.getMatchTolerances', managerToken);
    expect(getResponse.statusCode).toBe(403);

    const updateResponse = await call('settings.updateMatchTolerances', managerToken, { matchPriceTolerancePercent: '0.1000' });
    expect(updateResponse.statusCode).toBe(403);
  });

  it('rejects an out-of-range percent tolerance with a real 400, never silently clamping it', async () => {
    const organizationId = await setUpOrg();
    const token = await issueSession(organizationId, 'OWNER', ['settings:manage']);

    const response = await call('settings.updateMatchTolerances', token, { matchPriceTolerancePercent: '1.5000' });
    expect(response.statusCode).toBe(400);
  });

  it('an explicit null clears a previously-set override back to the default', async () => {
    const organizationId = await setUpOrg();
    const token = await issueSession(organizationId, 'OWNER', ['settings:manage']);

    await call('settings.updateMatchTolerances', token, { matchPriceTolerancePercent: '0.0800' });
    const cleared = await call('settings.updateMatchTolerances', token, { matchPriceTolerancePercent: null });
    expect(cleared.statusCode).toBe(200);
    const body = JSON.parse(cleared.body).result.data;
    expect(body.matchPriceTolerancePercent).toBeNull();
  });
});
