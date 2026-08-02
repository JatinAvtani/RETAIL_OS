import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  hashPassword,
  memberships,
  organizations,
  products,
  units,
  users,
} from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildProductImageKey } from '@retailos/storage';
import { buildServer } from '../../server';
import type { FastifyInstance } from 'fastify';

type TrpcSuccess = { result: { data: Record<string, unknown> } };
type TrpcError = { error: { message: string; data: { code: string } } };

const asSuccess = (body: TrpcSuccess | TrpcError): TrpcSuccess['result']['data'] => {
  if (!('result' in body)) {
    throw new Error(`Expected a successful tRPC response, got an error: ${JSON.stringify(body)}`);
  }
  return body.result.data;
};

const asError = (body: TrpcSuccess | TrpcError): TrpcError['error'] => {
  if (!('error' in body)) {
    throw new Error(`Expected a tRPC error response, got success: ${JSON.stringify(body)}`);
  }
  return body.error;
};

const REAL_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/**
 * Real Postgres + real Redis + real MinIO + real HTTP: proves the two-step presigned-upload flow
 * (spec 14 §14.3/§14.7) end to end — a presigned URL is issued, a real PUT with real image bytes
 * succeeds against it, and only THEN does `confirmImageUpload` verify the actual uploaded bytes
 * (magic bytes, not the claimed content-type) before writing `products.imageKey`.
 */
describe('products router — image upload', () => {
  let app: FastifyInstance;
  const { db } = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos'
  );
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];
  const createdProductIds: string[] = [];

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
    for (const productId of createdProductIds) {
      await db.delete(products).where(eq(products.id, productId));
    }
    for (const orgId of createdOrgIds) {
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    createdUserIds.length = 0;
    createdOrgIds.length = 0;
    createdProductIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  const uniqueEmail = (label: string) =>
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  /** A real org, a real logged-in Owner, and a real product to attach an image to. */
  const setUpOrgWithProduct = async (): Promise<{ organizationId: string; productId: string; sessionCookie: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Product Image Test Org ${organizationId}`,
      slug: `product-image-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    const [eachUnit] = await db.select({ id: units.id }).from(units).where(eq(units.code, 'each'));
    const productId = generateId();
    createdProductIds.push(productId);
    await db.insert(products).values({
      id: productId,
      organizationId,
      sku: `product-image-test-${productId}`,
      name: 'Test Product',
      baseUnitId: eachUnit!.id,
      type: 'INGREDIENT',
    });

    const email = uniqueEmail('product-image');
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

    return { organizationId, productId, sessionCookie };
  };

  it('requestImageUpload returns a presigned URL that accepts a real PUT', async () => {
    const { productId, sessionCookie } = await setUpOrgWithProduct();

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/products.requestImageUpload',
      payload: { productId, contentType: 'image/jpeg' },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(requestResponse.statusCode).toBe(200);
    const { uploadUrl } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };

    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: REAL_JPEG_BYTES,
    });
    expect(putResponse.ok).toBe(true);
  });

  it('confirmImageUpload sets the product imageKey after verifying real uploaded bytes', async () => {
    const { productId, sessionCookie } = await setUpOrgWithProduct();

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/products.requestImageUpload',
      payload: { productId, contentType: 'image/jpeg' },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: REAL_JPEG_BYTES });

    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/trpc/products.confirmImageUpload',
      payload: { productId, key },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(confirmResponse.statusCode).toBe(200);
    const updated = asSuccess(confirmResponse.json()) as { imageKey: string };
    expect(updated.imageKey).toBe(key);
  });

  it('confirmImageUpload rejects an object whose real bytes are not a valid image, regardless of the declared content-type', async () => {
    const { productId, sessionCookie } = await setUpOrgWithProduct();

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/products.requestImageUpload',
      payload: { productId, contentType: 'image/jpeg' },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    // Uploads plain text, not a real JPEG, even though the presigned URL and the PUT's
    // Content-Type header both claim image/jpeg — the server-side magic-byte check is what
    // actually decides, not either of those caller-controlled claims.
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: 'this is not an image',
    });

    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/trpc/products.confirmImageUpload',
      payload: { productId, key },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(confirmResponse.statusCode).toBe(400);
    expect(asError(confirmResponse.json()).message).toMatch(/not a valid/i);

    const [productRow] = await db.select().from(products).where(eq(products.id, productId));
    expect(productRow?.imageKey).toBeNull();
  });

  it('confirmImageUpload rejects a key not prefixed with the caller\'s own organizationId', async () => {
    const { productId, sessionCookie } = await setUpOrgWithProduct();

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/products.confirmImageUpload',
      payload: { productId, key: buildProductImageKey('some-other-org', productId, 'jpg') },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it('requestImageUpload returns 404 for a product that does not exist in the caller\'s organization', async () => {
    const { sessionCookie } = await setUpOrgWithProduct();

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/products.requestImageUpload',
      payload: { productId: generateId(), contentType: 'image/jpeg' },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects an unauthenticated requestImageUpload with 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/products.requestImageUpload',
      payload: { productId: generateId(), contentType: 'image/jpeg' },
    });

    expect(response.statusCode).toBe(401);
  });
});
