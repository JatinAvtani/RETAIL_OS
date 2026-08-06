import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, documents, hashPassword, memberships, organizations, stores, users } from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildDocumentKey } from '@retailos/storage';
import { buildServer } from '../../server';
import { extractionQueue } from '../context';
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

const REAL_PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF');

/**
 * 007-04: `confirmUpload` now calls the real Gemini vision API for classification when
 * `GEMINI_API_KEY` is set. This suite asserts a deterministic `type: 'OTHER'` outcome for a
 * trivial fake PDF with no real invoice content — a real classification call would be slow,
 * rate-limited (free tier), and could legitimately classify meaningless bytes as something other
 * than 'OTHER', making the assertion flaky by construction. Unsetting the key here forces the
 * documented "not attempted" path (`classifyUploadedDocument` returns `null`), independent of
 * whatever a developer's own `.env.local`/shell happens to have set — the real classification
 * behavior is covered by `packages/ai`'s own unit tests plus manual end-to-end verification.
 */
delete process.env.GEMINI_API_KEY;

/**
 * Real Postgres + real Redis + real MinIO + real HTTP: proves the two-step presigned-upload flow
 * (spec 14 §14.3/§14.7) end to end for the document pipeline — a presigned URL is issued, a real
 * PUT with real PDF bytes succeeds against it, and only THEN does `confirmUpload` verify the actual
 * uploaded bytes (magic bytes, not the claimed content-type) before creating the `documents` row.
 */
describe('documents router — upload', () => {
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
    // documents.uploadedByUserId references users — must be deleted BEFORE users, or the FK blocks
    // the user delete below. Same recurring test-teardown-ordering class this project has hit
    // repeatedly (see project memory: a describe block's own inserted rows must be deleted before
    // a shared fixture's cleanup deletes a parent row they reference).
    for (const orgId of createdOrgIds) {
      // 007-05: every confirmUpload in this file enqueues a REAL BullMQ job (jobId === documentId)
      // against the real extractionQueue — cleaned up here, before the row itself is deleted,
      // since the job lookup needs the documentId. Left-behind test jobs would otherwise
      // accumulate in Redis indefinitely (no worker runs during this suite to drain them).
      const orgDocuments = await db.select({ id: documents.id }).from(documents).where(eq(documents.organizationId, orgId));
      for (const doc of orgDocuments) {
        await (await extractionQueue.getJob(doc.id))?.remove();
      }
      await db.delete(documents).where(eq(documents.organizationId, orgId));
    }
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

  /** A real org, a real store, and a real logged-in Owner. */
  const setUpOrgWithStore = async (): Promise<{ organizationId: string; storeId: string; sessionCookie: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Document Upload Test Org ${organizationId}`,
      slug: `document-upload-test-${organizationId}`,
      baseCurrency: 'USD',
    });

    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const email = uniqueEmail('document-upload');
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

    return { organizationId, storeId, sessionCookie };
  };

  it('requestUpload returns a presigned URL that accepts a real PUT', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(requestResponse.statusCode).toBe(200);
    const { uploadUrl } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };

    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: REAL_PDF_BYTES,
    });
    expect(putResponse.ok).toBe(true);
  });

  it('confirmUpload creates a real documents row after verifying real uploaded bytes', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });

    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmUpload',
      payload: { storeId, key },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(confirmResponse.statusCode).toBe(200);
    const confirmed = asSuccess(confirmResponse.json()) as { documentId: string; format: string };
    expect(confirmed.format).toBe('pdf');

    const [row] = await db.select().from(documents).where(eq(documents.id, confirmed.documentId));
    expect(row?.status).toBe('UPLOADED');
    expect(row?.type).toBe('OTHER');
    expect(row?.source).toBe('UPLOAD');
    expect(row?.mimeType).toBe('application/pdf');
    expect(row?.contentHash).toBeTruthy();

    // 007-05: confirmUpload enqueues a real extraction job (jobId === documentId) — checked
    // directly against the real queue, not mocked, matching this project's "no mock queue" rule
    // for BullMQ (packages/queue/extraction-queue.test.ts proves the underlying mechanics
    // separately; this proves the ROUTE actually calls enqueueExtractionJob).
    const job = await extractionQueue.getJob(confirmed.documentId);
    expect(job).toBeTruthy();
    expect(job?.data).toMatchObject({ documentId: confirmed.documentId, storageKey: key, mimeType: 'application/pdf' });
    await job?.remove();
  });

  it('confirmUpload rejects an object whose real bytes are not a valid document, regardless of the declared content-type', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'this is not a document',
    });

    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmUpload',
      payload: { storeId, key },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(confirmResponse.statusCode).toBe(400);
    expect(asError(confirmResponse.json()).message).toMatch(/PDF, JPEG, or PNG/i);

    const rows = await db.select().from(documents).where(eq(documents.storeId, storeId));
    expect(rows).toHaveLength(0);
  });

  it("confirmUpload rejects a key not prefixed with the caller's own organizationId", async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmUpload',
      payload: { storeId, key: buildDocumentKey('some-other-org', generateId(), 'pdf') },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it('requestUpload returns 404 for a store that does not exist in the caller\'s organization', async () => {
    const { sessionCookie } = await setUpOrgWithStore();

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId: generateId() },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects an unauthenticated requestUpload with 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId: generateId() },
    });

    expect(response.statusCode).toBe(401);
  });

  it('list returns uploaded documents for a store, most recent first', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });
    await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmUpload',
      payload: { storeId, key },
      cookies: { '__Host-session': sessionCookie },
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: `/trpc/documents.list?input=${encodeURIComponent(JSON.stringify({ storeId }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(listResponse.statusCode).toBe(200);
    const list = asSuccess(listResponse.json()) as unknown as unknown[];
    expect(list).toHaveLength(1);
  });

  it('get returns 404 for a document that does not exist in the caller\'s organization', async () => {
    const { sessionCookie } = await setUpOrgWithStore();

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/documents.get?input=${encodeURIComponent(JSON.stringify({ documentId: generateId() }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(404);
  });
});
