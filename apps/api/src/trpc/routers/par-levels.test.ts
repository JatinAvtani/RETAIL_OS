import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, memberships, organizations, productVariants, products, ProductRepository, stockParLevels, stores, units, users } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Permission } from '@retailos/authz';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

describe('parLevels — set/listForStore', () => {
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
    // Child-then-parent order: stock_par_levels (-> product_variants) before product_variants
    // (-> products) before products, and stores/memberships before organizations — same recurring
    // FK-teardown-order class this project's shared cross-tenant fixture has hit repeatedly.
    for (const orgId of createdOrgIds) {
      await db.delete(stockParLevels).where(eq(stockParLevels.organizationId, orgId));
      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(stores).where(eq(stores.organizationId, orgId));
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

  const query = async (path: string, cookie: string, input: Record<string, unknown>) =>
    app.inject({ method: 'GET', url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, cookies: { '__Host-session': cookie } });

  const issueSession = async (organizationId: string, role: 'OWNER' | 'STAFF', permissions: Permission[]): Promise<string> => {
    const userId = generateId();
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, email: `par-levels-router-${userId}@example.test` });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });
    const { token } = await sessionStore.create({ userId, organizationId, storeIds: 'ALL', role, permissions }, '127.0.0.1', 'test-agent');
    return token;
  };

  const setUpOrgStoreAndProduct = async () => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({ id: organizationId, name: `Par Levels Test Org ${organizationId}`, slug: `par-levels-test-${organizationId}`, baseCurrency: 'USD' });

    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: `Par Levels Test Store ${storeId}`, timezone: 'America/New_York' });

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    if (!eachUnit) throw new Error("par-levels.test.ts: seeded unit 'each' not found — migrations not applied?");

    const productRepository = new ProductRepository(db, organizationId);
    const product = await productRepository.create({
      id: generateId(),
      sku: `par-levels-probe-${generateId()}`,
      name: 'Par Levels Probe Product',
      baseUnitId: eachUnit.id,
      type: 'INGREDIENT',
    });
    const [variant] = await productRepository.findVariants(product.id);
    if (!variant) throw new Error('par-levels.test.ts: seeded product has no default variant.');

    return { organizationId, storeId, productId: product.id, variantId: variant.id };
  };

  it('set writes a real row a subsequent listForStore reads back', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreAndProduct();
    const token = await issueSession(organizationId, 'OWNER', []);

    const response = await call('parLevels.set', token, { storeId, productId, variantId, parLevel: '20.000000', reorderPoint: '10.000000' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body).result.data;
    expect(body.parLevel).toBe('20.000000');
    expect(body.reorderPoint).toBe('10.000000');

    const list = await query('parLevels.listForStore', token, { storeId });
    const listBody = JSON.parse(list.body).result.data as Array<{ productId: string; parLevel: string | null }>;
    expect(listBody.some((row) => row.productId === productId && row.parLevel === '20.000000')).toBe(true);
  });

  it('set is a real upsert — setting again for the same (store, product, variant) updates, not duplicates', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreAndProduct();
    const token = await issueSession(organizationId, 'OWNER', []);

    await call('parLevels.set', token, { storeId, productId, variantId, parLevel: '20.000000' });
    await call('parLevels.set', token, { storeId, productId, variantId, parLevel: '35.000000' });

    const list = await query('parLevels.listForStore', token, { storeId });
    const listBody = JSON.parse(list.body).result.data as Array<{ productId: string; parLevel: string | null }>;
    const matching = listBody.filter((row) => row.productId === productId);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.parLevel).toBe('35.000000');
  });

  it('set leaves an omitted field null, never a fabricated 0 (I7)', async () => {
    const { organizationId, storeId, productId, variantId } = await setUpOrgStoreAndProduct();
    const token = await issueSession(organizationId, 'OWNER', []);

    const response = await call('parLevels.set', token, { storeId, productId, variantId, parLevel: '20.000000' });
    const body = JSON.parse(response.body).result.data;
    expect(body.parLevel).toBe('20.000000');
    expect(body.reorderPoint).toBeNull();
  });

  it('set 404s for a storeId from a different organization (cross-tenant, I4)', async () => {
    const seededA = await setUpOrgStoreAndProduct();
    const seededB = await setUpOrgStoreAndProduct();
    const tokenB = await issueSession(seededB.organizationId, 'OWNER', []);

    const response = await call('parLevels.set', tokenB, {
      storeId: seededA.storeId,
      productId: seededA.productId,
      variantId: seededA.variantId,
      parLevel: '20.000000',
    });
    expect(response.statusCode).toBe(404);
  });

  it('set 400s for a productId that does not refer to a real product in this org', async () => {
    const { organizationId, storeId, variantId } = await setUpOrgStoreAndProduct();
    const token = await issueSession(organizationId, 'OWNER', []);

    const response = await call('parLevels.set', token, { storeId, productId: generateId(), variantId, parLevel: '20.000000' });
    expect(response.statusCode).toBe(400);
  });
});
