import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, memberships, onboardingProgress, organizations, users } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('onboarding — getProgress/setStepStatus/dismiss', () => {
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
      await db.delete(onboardingProgress).where(eq(onboardingProgress.organizationId, orgId));
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

  const issueSession = async (organizationId: string, role: 'OWNER' | 'STAFF', permissions: Permission[]): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `onboarding-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role, permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const setUpOrg = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Onboarding Test Org ${organizationId}`, slug: `onboarding-test-${organizationId}`, baseCurrency: 'USD' });
    return organizationId;
  };

  it('getProgress lazily creates a real row, every step PENDING, for a caller with no permissions beyond a valid session', async () => {
    const organizationId = await setUpOrg();
    const token = await issueSession(organizationId, 'STAFF', []);

    const response = await query('onboarding.getProgress', token);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.salesConnectedStatus).toBe('PENDING');
    expect(body.invoicesUploadedStatus).toBe('PENDING');
    expect(body.entitiesConfirmedStatus).toBe('PENDING');
    expect(body.parLevelsSetStatus).toBe('PENDING');
    expect(body.dismissed).toBe(false);
  });

  it('setStepStatus writes a real change an immediate getProgress reads back', async () => {
    const organizationId = await setUpOrg();
    const token = await issueSession(organizationId, 'OWNER', []);

    const update = await call('onboarding.setStepStatus', token, { step: 'invoicesUploadedStatus', status: 'DONE' });
    expect(update.statusCode).toBe(200);
    expect(JSON.parse(update.body).result.data.invoicesUploadedStatus).toBe('DONE');

    const readBack = await query('onboarding.getProgress', token);
    expect(JSON.parse(readBack.body).result.data.invoicesUploadedStatus).toBe('DONE');
  });

  it('setStepStatus rejects an unrecognized step at the Zod boundary', async () => {
    const organizationId = await setUpOrg();
    const token = await issueSession(organizationId, 'OWNER', []);

    const response = await call('onboarding.setStepStatus', token, { step: 'notARealStep', status: 'DONE' });
    expect(response.statusCode).toBe(400);
  });

  it('dismiss sets dismissed=true, independent of step progress', async () => {
    const organizationId = await setUpOrg();
    const token = await issueSession(organizationId, 'OWNER', []);

    const response = await call('onboarding.dismiss', token, {});
    expect(response.statusCode).toBe(200);

    const readBack = await query('onboarding.getProgress', token);
    expect(JSON.parse(readBack.body).result.data.dismissed).toBe(true);
  });

  it('is genuinely org-scoped — one org never sees or affects another org\'s progress row', async () => {
    const orgA = await setUpOrg();
    const orgB = await setUpOrg();
    const tokenA = await issueSession(orgA, 'OWNER', []);
    const tokenB = await issueSession(orgB, 'OWNER', []);

    await call('onboarding.setStepStatus', tokenA, { step: 'salesConnectedStatus', status: 'DONE' });

    const orgBProgress = await query('onboarding.getProgress', tokenB);
    expect(JSON.parse(orgBProgress.body).result.data.salesConnectedStatus).toBe('PENDING');
  });
});
