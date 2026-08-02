import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  categories,
  hashPassword,
  memberships,
  organizations,
  productVariants,
  products,
  recipeComponents,
  recipes,
  stores,
  users,
} from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildServer } from '../server';
import { appRouter } from './router';
import { resourceScopedProcedures } from './cross-tenant-registry';
import type { FastifyInstance } from 'fastify';

/**
 * Task 003-13, spec 14 §14.3, the closing merge-gate suite: for every registered route that fetches
 * a resource by id, prove that tenant B's session can never read tenant A's resource — 403/404,
 * never 200. Two enforcement mechanisms in one file:
 *
 * 1. A completeness check: every `query`/`mutation` procedure actually registered on `appRouter`
 *    that takes an `id`-shaped input MUST appear in `resourceScopedProcedures` — this is what
 *    makes "every future endpoint inherits it automatically" true rather than aspirational. Add a
 *    new resource-fetching endpoint without registering it here, and this suite fails loudly on
 *    the next run, not silently.
 * 2. The actual attack, run once per registered entry: seed a real resource in tenant A, log in as
 *    a real tenant B user, call the real endpoint over real HTTP with tenant B's session against
 *    tenant A's resource id, assert the response is never a 200.
 */
describe('cross-tenant suite (003-13 merge gate)', () => {
  let app: FastifyInstance;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      const tokens = await redis.smembers(`user-sessions:${userId}`);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => `session:${t}`), `user-sessions:${userId}`);
      }
      await db.delete(memberships).where(eq(memberships.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    for (const orgId of createdOrgIds) {
      await db.delete(stores).where(eq(stores.organizationId, orgId));
      // products.requestImageUpload/confirmImageUpload/products.create's registry entries seed
      // real products — products.create specifically calls the REAL create endpoint, which always
      // inserts a default product_variants row too (ProductRepository.create's own invariant), so
      // variants must go before products, which must go before categories (products.create's
      // categoryId FK), which must go before the org, in strict FK order.
      // recipes.get/cost/create's registry entries seed real recipes+components — components
      // reference products via a real FK, so they must go before products; recipes reference the
      // org directly, so they must go before the org too.
      const orgRecipes = await db.select({ id: recipes.id }).from(recipes).where(eq(recipes.organizationId, orgId));
      for (const r of orgRecipes) {
        await db.delete(recipeComponents).where(eq(recipeComponents.recipeId, r.id));
      }
      await db.delete(recipes).where(eq(recipes.organizationId, orgId));

      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(categories).where(eq(categories.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdUserIds.length = 0;
    createdOrgIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const uniqueEmail = (label: string) =>
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  /** A real org with a real, logged-in OWNER — returns the org id and a real session cookie. */
  const setUpRealTenant = async (label: string): Promise<{ organizationId: string; sessionCookie: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `${label} Org`,
      slug: `${label.toLowerCase()}-org-${organizationId}`,
      baseCurrency: 'USD',
    });

    const email = uniqueEmail(`cross-tenant-${label.toLowerCase()}`);
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({
      id: generateId(),
      organizationId,
      userId,
      role: 'OWNER',
      acceptedAt: new Date(),
    });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password },
    });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    return { organizationId, sessionCookie };
  };

  it('every registered id-shaped procedure is covered by the cross-tenant registry', () => {
    const registeredPaths = new Set(resourceScopedProcedures.map((p) => p.path));

    // appRouter._def.record is a NESTED tree ({ stores: { get: Procedure, list: Procedure }, ... }),
    // not a flat dotted map — walked recursively to build real dotted paths ('stores.get').
    type ProcedureLike = { _def: { type?: string; inputs?: unknown[] } };
    type RouterNode = ProcedureLike | { [key: string]: RouterNode };

    const isProcedure = (node: RouterNode): node is ProcedureLike =>
      typeof (node as ProcedureLike)._def?.type === 'string';

    const walk = (node: RouterNode, prefix: string): string[] => {
      if (isProcedure(node)) {
        const def = node._def;
        if (def.type === 'subscription') {
          return [];
        }
        const inputSchema = def.inputs?.[0] as { shape?: Record<string, unknown> } | undefined;
        // Catches 'id' AND any 'xxxId' field (productId, storeId, ...) — a literal-'id'-only check
        // silently misses an endpoint like requestImageUpload({ productId }), which is exactly as
        // resource-scoped as one shaped { id }, just with a more specific field name.
        const looksResourceScoped = Boolean(
          inputSchema?.shape && Object.keys(inputSchema.shape).some((key) => key === 'id' || key.endsWith('Id'))
        );
        return looksResourceScoped ? [prefix] : [];
      }
      return Object.entries(node).flatMap(([key, child]) =>
        walk(child, prefix ? `${prefix}.${key}` : key)
      );
    };

    const resourceScopedPaths = walk(appRouter._def.record as RouterNode, '');
    const uncovered = resourceScopedPaths.filter((path) => !registeredPaths.has(path));

    expect(uncovered).toEqual([]);
  });

  it.each(resourceScopedProcedures)(
    'tenant B is denied fetching tenant A\'s resource via $path',
    async (procedure) => {
      const tenantA = await setUpRealTenant('Tenant-A');
      const tenantB = await setUpRealTenant('Tenant-B');

      const resourceId = await procedure.seedResource(db, tenantA.organizationId);
      const input = await procedure.buildInput(resourceId, tenantA.organizationId, db);

      const response =
        procedure.type === 'query'
          ? await app.inject({
              method: 'GET',
              url: `/trpc/${procedure.path}?input=${encodeURIComponent(JSON.stringify(input))}`,
              cookies: { '__Host-session': tenantB.sessionCookie },
            })
          : await app.inject({
              method: 'POST',
              url: `/trpc/${procedure.path}`,
              payload: input,
              cookies: { '__Host-session': tenantB.sessionCookie },
            });

      expect(response.statusCode).not.toBe(200);
      expect([403, 404]).toContain(response.statusCode);
    }
  );

  it.each(resourceScopedProcedures)(
    'tenant A can still fetch their OWN resource via $path (the check is not blocking everyone)',
    async (procedure) => {
      const tenantA = await setUpRealTenant('Tenant-A');

      const resourceId = await procedure.seedResource(db, tenantA.organizationId);
      const input = await procedure.buildInput(resourceId, tenantA.organizationId, db);

      const response =
        procedure.type === 'query'
          ? await app.inject({
              method: 'GET',
              url: `/trpc/${procedure.path}?input=${encodeURIComponent(JSON.stringify(input))}`,
              cookies: { '__Host-session': tenantA.sessionCookie },
            })
          : await app.inject({
              method: 'POST',
              url: `/trpc/${procedure.path}`,
              payload: input,
              cookies: { '__Host-session': tenantA.sessionCookie },
            });

      expect(response.statusCode).toBe(200);
    }
  );
});
