import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  auditLogs,
  createDb,
  documentExtractions,
  documents,
  extractionCorrections,
  hashPassword,
  invoiceMatchLines,
  invoiceMatches,
  supplierPerformanceEvents,
  memberships,
  organizations,
  outboxEvents,
  products,
  productVariants,
  stores,
  supplierProducts,
  suppliers,
  users,
  ProductRepository,
  SupplierRepository,
  UnitRepository,
} from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import type { Role } from '@retailos/authz';
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
 * `confirmUpload` now calls the real Gemini vision API for classification when
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
 * end to end for the document pipeline — a presigned URL is issued, a real
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
      // every confirmUpload in this file enqueues a REAL BullMQ job (jobId === documentId)
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

  /** A real org, a real store, and a real logged-in user with the given role (Owner by default). */
  const setUpOrgWithStore = async (
    role: Role = 'OWNER'
  ): Promise<{ organizationId: string; storeId: string; sessionCookie: string }> => {
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
      role,
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

    // confirmUpload enqueues a real extraction job (jobId === documentId) — checked
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

  it('search filters by status via real HTTP', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();

    const requestResponse = await app.inject({ method: 'POST', url: '/trpc/documents.requestUpload', payload: { storeId }, cookies: { '__Host-session': sessionCookie } });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });
    await app.inject({ method: 'POST', url: '/trpc/documents.confirmUpload', payload: { storeId, key }, cookies: { '__Host-session': sessionCookie } });

    const noMatchResponse = await app.inject({
      method: 'GET',
      url: `/trpc/documents.search?input=${encodeURIComponent(JSON.stringify({ storeId, status: 'REVIEW_REQUIRED' }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    expect(noMatchResponse.statusCode).toBe(200);
    expect(asSuccess(noMatchResponse.json())).toHaveLength(0);

    const matchResponse = await app.inject({
      method: 'GET',
      url: `/trpc/documents.search?input=${encodeURIComponent(JSON.stringify({ storeId, status: 'UPLOADED' }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    expect(matchResponse.statusCode).toBe(200);
    expect(asSuccess(matchResponse.json())).toHaveLength(1);
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

/**
 * the review workflow's real HTTP surface — `getForReview` (everything the screen needs in
 * one call), `approve`, `reject`. Real Postgres + real Redis + real MinIO (a presigned download url
 * genuinely needs a real object to point at). `documents:approve` is deliberately a STRICTER, SEPARATE
 * permission from `documents:read` (the design: Accountant/VIEWER_FINANCE can view a document but
 * never approve one) — tested directly with a real VIEWER_FINANCE session, not assumed from the
 * permission model alone.
 */
describe('documents router — review', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      const orgDocuments = await db.select({ id: documents.id }).from(documents).where(eq(documents.organizationId, orgId));
      for (const doc of orgDocuments) {
        await (await extractionQueue.getJob(doc.id))?.remove();
      }
      await db.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      // approve/reject write real audit_logs.actor_user_id rows referencing the test user — these
      // must be deleted BEFORE the users delete below, or the FK blocks it. Same recurring
      // FK-teardown-order bug class this project has hit repeatedly (see project memory).
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
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

  const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const setUpOrgWithStore = async (
    role: Role = 'OWNER'
  ): Promise<{ organizationId: string; storeId: string; sessionCookie: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Document Review Test Org ${organizationId}`,
      slug: `document-review-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const email = uniqueEmail('document-review');
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });

    const loginResponse = await app.inject({ method: 'POST', url: '/trpc/auth.login', payload: { email, password } });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    return { organizationId, storeId, sessionCookie };
  };

  /** A real document at REVIEW_REQUIRED with a real extraction row — via a real upload, not a bare INSERT, so the storage key genuinely resolves to real bytes for getForReview's presigned url. */
  const seedDocumentAwaitingReview = async (organizationId: string, storeId: string, ownerSessionCookie: string): Promise<string> => {
    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': ownerSessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });

    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmUpload',
      payload: { storeId, key },
      cookies: { '__Host-session': ownerSessionCookie },
    });
    const { documentId } = asSuccess(confirmResponse.json()) as { documentId: string };

    await db.insert(documentExtractions).values({
      id: generateId(),
      organizationId,
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: {
        supplier: { value: 'Test Supplier', confidence: 0.9 },
        documentNumber: { value: 'INV-1', confidence: 0.9 },
        documentDate: { value: '2026-01-01', confidence: 0.9 },
        currency: { value: 'USD', confidence: 1 },
        subtotal: { value: '10.00', confidence: 0.9 },
        tax: { value: '0', confidence: 0.9 },
        discount: { value: null, confidence: null },
        total: { value: '10.00', confidence: 0.9 },
      },
      lines: [],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });
    await db.update(documents).set({ status: 'REVIEW_REQUIRED' }).where(eq(documents.id, documentId));

    return documentId;
  };

  it('getForReview returns the document, its latest extraction, and a real presigned download url', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore();
    const documentId = await seedDocumentAwaitingReview(organizationId, storeId, sessionCookie);

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/documents.getForReview?input=${encodeURIComponent(JSON.stringify({ documentId }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = asSuccess(response.json()) as { document: { id: string }; extraction: { provider: string } | null; imageUrl: string };
    expect(body.document.id).toBe(documentId);
    expect(body.extraction?.provider).toBe('gemini');
    expect(body.imageUrl).toMatch(/^https?:\/\//);

    // The presigned url genuinely resolves to the real uploaded bytes, not just a well-formed string.
    const imageResponse = await fetch(body.imageUrl);
    expect(imageResponse.ok).toBe(true);
  });

  it('a VIEWER_FINANCE session in the SAME org can view a document for review but cannot approve it — documents:approve is a stricter, separate permission from documents:read', async () => {
    const owner = await setUpOrgWithStore('OWNER');
    const documentId = await seedDocumentAwaitingReview(owner.organizationId, owner.storeId, owner.sessionCookie);

    // A second, VIEWER_FINANCE user in the SAME org — isolates the permission check from tenant
    // isolation entirely (a different-org caller would correctly get 404 from findById first, not
    // 403, which would test the wrong thing).
    const viewerEmail = uniqueEmail('document-review-viewer');
    const viewerPassword = 'a-genuinely-long-password-123';
    const viewerUserId = generateId();
    createdUserIds.push(viewerUserId);
    const viewerPasswordHash = await hashPassword(viewerPassword);
    await db.insert(users).values({ id: viewerUserId, email: viewerEmail, passwordHash: viewerPasswordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({ id: generateId(), organizationId: owner.organizationId, userId: viewerUserId, role: 'VIEWER_FINANCE', acceptedAt: new Date() });
    const viewerLoginResponse = await app.inject({ method: 'POST', url: '/trpc/auth.login', payload: { email: viewerEmail, password: viewerPassword } });
    const viewerSessionCookie = viewerLoginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    const reviewResponse = await app.inject({
      method: 'GET',
      url: `/trpc/documents.getForReview?input=${encodeURIComponent(JSON.stringify({ documentId }))}`,
      cookies: { '__Host-session': viewerSessionCookie },
    });
    expect(reviewResponse.statusCode).toBe(200);

    const approveResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.approve',
      payload: { documentId },
      cookies: { '__Host-session': viewerSessionCookie },
    });
    expect(approveResponse.statusCode).toBe(403);
  });

  it('approve moves a REVIEW_REQUIRED document all the way to POSTED (approve triggers posting synchronously) for a caller with documents:approve', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore('MANAGER');
    // seedDocumentAwaitingReview's fixture has `lines: []` — no line items, so PostingService
    // trivially posts nothing per-line and moves straight to POSTED (never getting stuck at
    // APPROVED). posting-service.test.ts and the dedicated describe block below cover the
    // real per-line posting math; this test only proves the status transition genuinely reaches
    // POSTED via the real HTTP endpoint, not just APPROVED.
    const documentId = await seedDocumentAwaitingReview(organizationId, storeId, sessionCookie);

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/documents.approve',
      payload: { documentId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = asSuccess(response.json()) as { status: string };
    expect(body.status).toBe('POSTED');

    const [row] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(row?.status).toBe('POSTED');
  });

  it('reject moves a REVIEW_REQUIRED document to REJECTED with a real reason', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore('MANAGER');
    const documentId = await seedDocumentAwaitingReview(organizationId, storeId, sessionCookie);

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/documents.reject',
      payload: { documentId, reason: 'Illegible scan, please re-upload.' },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = asSuccess(response.json()) as { status: string };
    expect(body.status).toBe('REJECTED');
  });

  it('a STAFF session gets 403 attempting getForReview — documents:read is not granted to Staff', async () => {
    const { sessionCookie } = await setUpOrgWithStore('STAFF');

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/documents.getForReview?input=${encodeURIComponent(JSON.stringify({ documentId: generateId() }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it('approve returns 400 for a document that is not awaiting review (e.g. already APPROVED)', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore('MANAGER');
    const documentId = await seedDocumentAwaitingReview(organizationId, storeId, sessionCookie);
    await app.inject({ method: 'POST', url: '/trpc/documents.approve', payload: { documentId }, cookies: { '__Host-session': sessionCookie } });

    const secondApprove = await app.inject({
      method: 'POST',
      url: '/trpc/documents.approve',
      payload: { documentId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(secondApprove.statusCode).toBe(400);
  });
});

/**
 * correction capture → supplier-SKU mapping table. Real Postgres + real
 * Redis + real MinIO. `documents.confirmLineMapping` is the endpoint that turns an extraction
 * line's SKU into a PERMANENT `supplier_products` row — the input the posting engine needs.
 */
describe('documents router — corrections / supplier-SKU mapping', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      const orgDocuments = await db.select({ id: documents.id }).from(documents).where(eq(documents.organizationId, orgId));
      for (const doc of orgDocuments) {
        await (await extractionQueue.getJob(doc.id))?.remove();
      }
      // confirmLineMapping writes real extraction_corrections rows (extraction_corrections.extraction_id
      // -> document_extractions.id) — must be gone before document_extractions is deleted, the Nth
      // confirmed instance of this project's own recurring FK-teardown-order bug class.
      await db.delete(extractionCorrections).where(eq(extractionCorrections.organizationId, orgId));
      await db.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      // supplier_products references products (FK) and suppliers (FK) —
      // must be gone before those parent rows are deleted below. Same recurring FK-teardown-order
      // class this project has hit repeatedly.
      await db.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));
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

  const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const setUpOrgWithStore = async (
    role: Role = 'OWNER'
  ): Promise<{ organizationId: string; storeId: string; sessionCookie: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Document Correction Test Org ${organizationId}`,
      slug: `document-correction-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const email = uniqueEmail('document-correction');
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role, acceptedAt: new Date() });

    const loginResponse = await app.inject({ method: 'POST', url: '/trpc/auth.login', payload: { email, password } });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    return { organizationId, storeId, sessionCookie };
  };

  /** A real document at REVIEW_REQUIRED with a real extraction carrying ONE real line item — the shared `seedDocumentAwaitingReview` helper in the sibling describe block seeds `lines: []`, which is useless for a line-mapping test. */
  const seedDocumentWithLine = async (
    organizationId: string,
    storeId: string,
    ownerSessionCookie: string,
    sku: string,
    supplierName = 'Test Supplier'
  ): Promise<string> => {
    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': ownerSessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });

    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmUpload',
      payload: { storeId, key },
      cookies: { '__Host-session': ownerSessionCookie },
    });
    const { documentId } = asSuccess(confirmResponse.json()) as { documentId: string };

    await db.insert(documentExtractions).values({
      id: generateId(),
      organizationId,
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: {
        supplier: { value: supplierName, confidence: 0.9 },
        documentNumber: { value: 'INV-CORR-1', confidence: 0.9 },
        documentDate: { value: '2026-01-01', confidence: 0.9 },
        currency: { value: 'USD', confidence: 1 },
        subtotal: { value: '10.00', confidence: 0.9 },
        tax: { value: '0', confidence: 0.9 },
        discount: { value: null, confidence: null },
        total: { value: '10.00', confidence: 0.9 },
      },
      lines: [
        {
          sku: { value: sku, confidence: 0.6 },
          description: { value: 'Some ingredient', confidence: 0.6 },
          quantity: { value: '2', confidence: 0.9 },
          unit: { value: 'ea', confidence: 0.9 },
          unitPrice: { value: '5.00', confidence: 0.9 },
          lineTotal: { value: '10.00', confidence: 0.9 },
        },
      ],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.7500',
    });
    await db.update(documents).set({ status: 'REVIEW_REQUIRED' }).where(eq(documents.id, documentId));

    return documentId;
  };

  const seedProduct = async (organizationId: string): Promise<string> => {
    const unitRepository = new UnitRepository(db);
    const eachUnit = await unitRepository.findByCode('each');
    const productRepository = new ProductRepository(db, organizationId);
    const product = await productRepository.create({
      id: generateId(),
      sku: `CORR-TEST-${generateId()}`,
      name: 'Correction Test Ingredient',
      baseUnitId: eachUnit!.id,
      type: 'INGREDIENT',
    });
    return product.id;
  };

  it('confirmLineMapping creates a new, permanently CONFIRMED supplier_products row for a fresh SKU', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore('OWNER');
    const supplierRepository = new SupplierRepository(db, organizationId);
    await supplierRepository.create({ id: generateId(), name: 'Test Supplier' });
    const productId = await seedProduct(organizationId);
    const documentId = await seedDocumentWithLine(organizationId, storeId, sessionCookie, 'FRESH-SKU-1');

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmLineMapping',
      payload: { documentId, lineIndex: 0, productId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const mapping = asSuccess(response.json()) as { isConfirmed: boolean; productId: string; supplierSku: string };
    expect(mapping.isConfirmed).toBe(true);
    expect(mapping.productId).toBe(productId);
    expect(mapping.supplierSku).toBe('FRESH-SKU-1');

    const [row] = await db.select().from(supplierProducts).where(eq(supplierProducts.supplierSku, 'FRESH-SKU-1'));
    expect(row?.isConfirmed).toBe(true);
  });

  it('confirmLineMapping records a real extraction_corrections row', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore('OWNER');
    const supplierRepository = new SupplierRepository(db, organizationId);
    await supplierRepository.create({ id: generateId(), name: 'Test Supplier' });
    const productId = await seedProduct(organizationId);
    const documentId = await seedDocumentWithLine(organizationId, storeId, sessionCookie, 'CORRECTION-TRACE-SKU');

    await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmLineMapping',
      payload: { documentId, lineIndex: 0, productId },
      cookies: { '__Host-session': sessionCookie },
    });

    const [extraction] = await db.select().from(documentExtractions).where(eq(documentExtractions.documentId, documentId));
    // extraction_corrections has no direct organizationId filter needed here — read it via a raw
    // query scoped by extractionId, matching how DocumentRepository.recordCorrection itself scopes.
    const correctionRows = await db.execute(
      `SELECT field_path, corrected_by_user_id FROM extraction_corrections WHERE extraction_id = '${extraction!.id}'`
    );
    expect(correctionRows.length).toBe(1);
    expect((correctionRows[0] as { field_path: string }).field_path).toBe('lines[0].sku');
  });

  it('confirmLineMapping is idempotent — mapping the same SKU a second time confirms the SAME row rather than creating a duplicate', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore('OWNER');
    const supplierRepository = new SupplierRepository(db, organizationId);
    await supplierRepository.create({ id: generateId(), name: 'Test Supplier' });
    const productId = await seedProduct(organizationId);
    const documentId = await seedDocumentWithLine(organizationId, storeId, sessionCookie, 'REPEAT-SKU');

    const first = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmLineMapping',
      payload: { documentId, lineIndex: 0, productId },
      cookies: { '__Host-session': sessionCookie },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmLineMapping',
      payload: { documentId, lineIndex: 0, productId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstMapping = asSuccess(first.json()) as { id: string };
    const secondMapping = asSuccess(second.json()) as { id: string };
    expect(secondMapping.id).toBe(firstMapping.id);

    // Org-scoped, not a bare SKU match. `supplier_sku` is unique per ORGANIZATION, not globally, so
    // a leftover 'REPEAT-SKU' row from another org (an earlier aborted run, a sibling test) made
    // this assert 2 and report a duplicate-write bug that never happened. The claim under test is
    // "this org has exactly one row for this SKU" — so that is what it now asks.
    const rows = await db
      .select()
      .from(supplierProducts)
      .where(and(eq(supplierProducts.organizationId, organizationId), eq(supplierProducts.supplierSku, 'REPEAT-SKU')));
    expect(rows).toHaveLength(1);
  });

  it('confirmLineMapping returns 400 when the extracted supplier has no matching real supplier row yet', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore('OWNER');
    const productId = await seedProduct(organizationId);
    const documentId = await seedDocumentWithLine(organizationId, storeId, sessionCookie, 'ORPHAN-SKU', 'Nonexistent Supplier Co.');

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmLineMapping',
      payload: { documentId, lineIndex: 0, productId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(400);
  });

  it('confirmLineMapping requires documents:approve — a VIEWER_FINANCE session gets 403', async () => {
    const owner = await setUpOrgWithStore('OWNER');
    const supplierRepository = new SupplierRepository(db, owner.organizationId);
    await supplierRepository.create({ id: generateId(), name: 'Test Supplier' });
    const productId = await seedProduct(owner.organizationId);
    const documentId = await seedDocumentWithLine(owner.organizationId, owner.storeId, owner.sessionCookie, 'PERM-TEST-SKU');

    const viewerEmail = uniqueEmail('document-correction-viewer');
    const viewerPassword = 'a-genuinely-long-password-123';
    const viewerUserId = generateId();
    createdUserIds.push(viewerUserId);
    const viewerPasswordHash = await hashPassword(viewerPassword);
    await db.insert(users).values({ id: viewerUserId, email: viewerEmail, passwordHash: viewerPasswordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({ id: generateId(), organizationId: owner.organizationId, userId: viewerUserId, role: 'VIEWER_FINANCE', acceptedAt: new Date() });
    const viewerLoginResponse = await app.inject({ method: 'POST', url: '/trpc/auth.login', payload: { email: viewerEmail, password: viewerPassword } });
    const viewerSessionCookie = viewerLoginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmLineMapping',
      payload: { documentId, lineIndex: 0, productId },
      cookies: { '__Host-session': viewerSessionCookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

/**
 * `documents.approve` genuinely triggers `PostingService.postDocument` end to end — this
 * proves the real HTTP path, not just the service class in isolation (that's
 * `posting-service.test.ts`'s own job). Real Postgres + real Redis + real MinIO.
 */
describe('documents router — approve triggers posting', () => {
  let app: FastifyInstance;
  const { db } = createDb(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/retailos');
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      const orgDocuments = await db.select({ id: documents.id }).from(documents).where(eq(documents.organizationId, orgId));
      for (const doc of orgDocuments) {
        await (await extractionQueue.getJob(doc.id))?.remove();
      }
      await db.execute(`DELETE FROM document_links WHERE organization_id = '${orgId}'`);
      await db.execute(`DELETE FROM stock_movements WHERE organization_id = '${orgId}'`);
      await db.execute(`DELETE FROM lots WHERE organization_id = '${orgId}'`);
      await db.execute(`DELETE FROM stock_levels WHERE organization_id = '${orgId}'`);
      await db.execute(
        `DELETE FROM supplier_prices WHERE supplier_product_id IN (SELECT id FROM supplier_products WHERE organization_id = '${orgId}')`
      );
      await db.delete(extractionCorrections).where(eq(extractionCorrections.organizationId, orgId));
      await db.delete(documentExtractions).where(eq(documentExtractions.organizationId, orgId));
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      // `approve` now runs InvoiceMatchRepository.runMatch for INVOICE-type documents —
      // invoice_matches/invoice_match_lines reference documents (and, when a PO was resolved,
      // purchase_order_lines) and must be gone before the documents delete just below.
      // supplier_performance_events references documents too (PRICE_VARIANCE/INVOICE_*
      // events written by the same runMatch call) — must go before the documents delete as well.
      await db.delete(supplierPerformanceEvents).where(eq(supplierPerformanceEvents.organizationId, orgId));
      await db.delete(invoiceMatchLines).where(eq(invoiceMatchLines.organizationId, orgId));
      await db.delete(invoiceMatches).where(eq(invoiceMatches.organizationId, orgId));
      await db.delete(documents).where(eq(documents.organizationId, orgId));
      await db.delete(supplierProducts).where(eq(supplierProducts.organizationId, orgId));
      const orgProducts = await db.select({ id: products.id }).from(products).where(eq(products.organizationId, orgId));
      for (const p of orgProducts) {
        await db.delete(productVariants).where(eq(productVariants.productId, p.id));
      }
      await db.delete(products).where(eq(products.organizationId, orgId));
      await db.delete(suppliers).where(eq(suppliers.organizationId, orgId));
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

  const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const setUpOrgWithStore = async (): Promise<{ organizationId: string; storeId: string; sessionCookie: string }> => {
    const organizationId = generateId();
    createdOrgIds.push(organizationId);
    await db.insert(organizations).values({
      id: organizationId,
      name: `Document Posting Test Org ${organizationId}`,
      slug: `document-posting-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const email = uniqueEmail('document-posting');
    const password = 'a-genuinely-long-password-123';
    const userId = generateId();
    createdUserIds.push(userId);
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: userId, email, passwordHash, emailVerifiedAt: new Date() });
    await db.insert(memberships).values({ id: generateId(), organizationId, userId, role: 'OWNER', acceptedAt: new Date() });

    const loginResponse = await app.inject({ method: 'POST', url: '/trpc/auth.login', payload: { email, password } });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === '__Host-session')!.value;

    return { organizationId, storeId, sessionCookie };
  };

  it('approve moves a document to POSTED and posts a real price/lot/movement for a confirmed line', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore();

    const supplierRepository = new SupplierRepository(db, organizationId);
    await supplierRepository.create({ id: generateId(), name: 'Posting E2E Supplier' });

    const unitRepository = new UnitRepository(db);
    const eachUnit = await unitRepository.findByCode('each');
    const productRepository = new ProductRepository(db, organizationId);
    const product = await productRepository.create({ id: generateId(), sku: `POST-E2E-${generateId()}`, name: 'Posting E2E Ingredient', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });

    // The real endpoint creates the confirmed mapping — proving the two flows compose, not just each in isolation.
    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });
    const confirmResponse = await app.inject({ method: 'POST', url: '/trpc/documents.confirmUpload', payload: { storeId, key }, cookies: { '__Host-session': sessionCookie } });
    const { documentId } = asSuccess(confirmResponse.json()) as { documentId: string };

    await db.insert(documentExtractions).values({
      id: generateId(),
      organizationId,
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: {
        supplier: { value: 'Posting E2E Supplier', confidence: 0.9 },
        documentNumber: { value: 'INV-POST-1', confidence: 0.9 },
        documentDate: { value: '2026-01-01', confidence: 0.9 },
        currency: { value: 'USD', confidence: 1 },
        subtotal: { value: '20.00', confidence: 0.9 },
        tax: { value: '0', confidence: 0.9 },
        discount: { value: null, confidence: null },
        total: { value: '20.00', confidence: 0.9 },
      },
      lines: [
        {
          sku: { value: 'POST-E2E-SKU', confidence: 0.9 },
          description: { value: 'Posting E2E line', confidence: 0.9 },
          quantity: { value: '2', confidence: 0.9 },
          unit: { value: 'ea', confidence: 0.9 },
          unitPrice: { value: '10.00', confidence: 0.9 },
          lineTotal: { value: '20.00', confidence: 0.9 },
        },
      ],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });
    await db.update(documents).set({ status: 'REVIEW_REQUIRED' }).where(eq(documents.id, documentId));

    const mapResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmLineMapping',
      payload: { documentId, lineIndex: 0, productId: product.id },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(mapResponse.statusCode).toBe(200);

    const approveResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.approve',
      payload: { documentId },
      cookies: { '__Host-session': sessionCookie },
    });

    expect(approveResponse.statusCode).toBe(200);
    const approvedBody = asSuccess(approveResponse.json()) as { status: string };
    // approve() returns the POST-POSTING state — POSTED, not just APPROVED — proving posting ran
    // synchronously inside the same request, not deferred to a background job.
    expect(approvedBody.status).toBe('POSTED');

    const [lotRow] = await db.execute(`SELECT unit_cost, initial_quantity FROM lots WHERE source_document_id = '${documentId}'`);
    expect((lotRow as { unit_cost: string } | undefined)?.unit_cost).toBe('10.0000');
    expect((lotRow as { initial_quantity: string } | undefined)?.initial_quantity).toBe('2.000000');

    const [movementRow] = await db.execute(`SELECT movement_type FROM stock_movements WHERE source_id = '${documentId}'`);
    expect((movementRow as { movement_type: string } | undefined)?.movement_type).toBe('RECEIPT');
  });

  /**
   * `approve` also runs the real three-way match for an INVOICE-type document, immediately
   * after posting, in the SAME request. Forces
   * `type: 'INVOICE'` directly via the DB (this suite deliberately unsets `GEMINI_API_KEY`, so
   * real classification never runs — see this file's own header comment) since the match-trigger
   * gate reads the document's real `type` column, not the extraction's raw `fields`.
   */
  it('approve also runs the real three-way match for an INVOICE document, reachable via invoiceMatches.getByDocument', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore();

    const supplierRepository = new SupplierRepository(db, organizationId);
    await supplierRepository.create({ id: generateId(), name: 'Match E2E Supplier' });

    const unitRepository = new UnitRepository(db);
    const eachUnit = await unitRepository.findByCode('each');
    const productRepository = new ProductRepository(db, organizationId);
    const product = await productRepository.create({ id: generateId(), sku: `MATCH-E2E-${generateId()}`, name: 'Match E2E Ingredient', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });
    const confirmResponse = await app.inject({ method: 'POST', url: '/trpc/documents.confirmUpload', payload: { storeId, key }, cookies: { '__Host-session': sessionCookie } });
    const { documentId } = asSuccess(confirmResponse.json()) as { documentId: string };

    // Force this document to INVOICE — real classification never runs in this suite (GEMINI_API_KEY unset).
    await db.update(documents).set({ type: 'INVOICE' }).where(eq(documents.id, documentId));

    await db.insert(documentExtractions).values({
      id: generateId(),
      organizationId,
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: {
        supplier: { value: 'Match E2E Supplier', confidence: 0.9 },
        documentNumber: { value: 'INV-MATCH-1', confidence: 0.9 },
        documentDate: { value: '2026-01-01', confidence: 0.9 },
        currency: { value: 'USD', confidence: 1 },
        subtotal: { value: '20.00', confidence: 0.9 },
        tax: { value: '0', confidence: 0.9 },
        discount: { value: null, confidence: null },
        total: { value: '20.00', confidence: 0.9 },
      },
      lines: [
        {
          sku: { value: 'MATCH-E2E-SKU', confidence: 0.9 },
          description: { value: 'Match E2E line', confidence: 0.9 },
          quantity: { value: '2', confidence: 0.9 },
          unit: { value: 'ea', confidence: 0.9 },
          unitPrice: { value: '10.00', confidence: 0.9 },
          lineTotal: { value: '20.00', confidence: 0.9 },
        },
      ],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });
    await db.update(documents).set({ status: 'REVIEW_REQUIRED' }).where(eq(documents.id, documentId));

    const mapResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.confirmLineMapping',
      payload: { documentId, lineIndex: 0, productId: product.id },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(mapResponse.statusCode).toBe(200);

    const approveResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.approve',
      payload: { documentId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(approveResponse.statusCode).toBe(200);

    // No PO/receipt exists anywhere for this product — the real three-way match must have run and
    // classified the line UNORDERED_ITEM (a real, honest "billed but never ordered or received").
    const matchResponse = await app.inject({
      method: 'GET',
      url: `/trpc/invoiceMatches.getByDocument?input=${encodeURIComponent(JSON.stringify({ documentId }))}`,
      cookies: { '__Host-session': sessionCookie },
    });
    expect(matchResponse.statusCode).toBe(200);
    const matchBody = asSuccess(matchResponse.json()) as { invoiceMatch: { highestSeverity: string; purchaseOrderId: string | null }; lines: { varianceType: string }[] };
    expect(matchBody.invoiceMatch.purchaseOrderId).toBeNull();
    expect(matchBody.invoiceMatch.highestSeverity).toBe('MEDIUM');
    expect(matchBody.lines).toHaveLength(1);
    expect(matchBody.lines[0]?.varianceType).toBe('UNORDERED_ITEM');
  });

  it('getLinks returns the real document_links rows PostingService wrote for a posted document', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore();

    const supplierRepository = new SupplierRepository(db, organizationId);
    await supplierRepository.create({ id: generateId(), name: 'Provenance E2E Supplier' });

    const unitRepository = new UnitRepository(db);
    const eachUnit = await unitRepository.findByCode('each');
    const productRepository = new ProductRepository(db, organizationId);
    const product = await productRepository.create({ id: generateId(), sku: `PROV-E2E-${generateId()}`, name: 'Provenance E2E Ingredient', baseUnitId: eachUnit!.id, type: 'INGREDIENT' });

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/documents.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });
    const confirmResponse = await app.inject({ method: 'POST', url: '/trpc/documents.confirmUpload', payload: { storeId, key }, cookies: { '__Host-session': sessionCookie } });
    const { documentId } = asSuccess(confirmResponse.json()) as { documentId: string };

    await db.insert(documentExtractions).values({
      id: generateId(),
      organizationId,
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: {
        supplier: { value: 'Provenance E2E Supplier', confidence: 0.9 },
        documentNumber: { value: 'INV-PROV-1', confidence: 0.9 },
        documentDate: { value: '2026-01-01', confidence: 0.9 },
        currency: { value: 'USD', confidence: 1 },
        subtotal: { value: '10.00', confidence: 0.9 },
        tax: { value: '0', confidence: 0.9 },
        discount: { value: null, confidence: null },
        total: { value: '10.00', confidence: 0.9 },
      },
      lines: [
        {
          sku: { value: 'PROV-E2E-SKU', confidence: 0.9 },
          description: { value: 'Provenance E2E line', confidence: 0.9 },
          quantity: { value: '1', confidence: 0.9 },
          unit: { value: 'ea', confidence: 0.9 },
          unitPrice: { value: '10.00', confidence: 0.9 },
          lineTotal: { value: '10.00', confidence: 0.9 },
        },
      ],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });
    await db.update(documents).set({ status: 'REVIEW_REQUIRED' }).where(eq(documents.id, documentId));

    await app.inject({ method: 'POST', url: '/trpc/documents.confirmLineMapping', payload: { documentId, lineIndex: 0, productId: product.id }, cookies: { '__Host-session': sessionCookie } });
    await app.inject({ method: 'POST', url: '/trpc/documents.approve', payload: { documentId }, cookies: { '__Host-session': sessionCookie } });

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/documents.getLinks?input=${encodeURIComponent(JSON.stringify({ documentId }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const links = asSuccess(response.json()) as unknown as { entityType: string; relationship: string }[];
    expect(links.map((l) => l.entityType).sort()).toEqual(['lot', 'stock_movement', 'supplier_price']);
  });

  it('accuracyTelemetry computes a real auto-approval rate and validation issue frequency from real extractions', async () => {
    const { organizationId, storeId, sessionCookie } = await setUpOrgWithStore();

    const seedExtraction = async (overrides: { canAutoApprove: boolean; overallConfidence: string; fieldConfidence: number; issueCode?: string }) => {
      const requestResponse = await app.inject({ method: 'POST', url: '/trpc/documents.requestUpload', payload: { storeId }, cookies: { '__Host-session': sessionCookie } });
      const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
      await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });
      const confirmResponse = await app.inject({ method: 'POST', url: '/trpc/documents.confirmUpload', payload: { storeId, key }, cookies: { '__Host-session': sessionCookie } });
      const { documentId } = asSuccess(confirmResponse.json()) as { documentId: string };
      await db.insert(documentExtractions).values({
        id: generateId(),
        organizationId,
        documentId,
        provider: 'gemini',
        modelVersion: 'flash-lite-v1',
        promptVersion: '1',
        fields: { supplier: { value: 'Telemetry Test Supplier', confidence: overrides.fieldConfidence } },
        lines: [],
        validation: {
          issues: overrides.issueCode ? [{ code: overrides.issueCode, severity: 'BLOCK', field: 'total', message: 'test' }] : [],
          canAutoApprove: overrides.canAutoApprove,
        },
        overallConfidence: overrides.overallConfidence,
      });
      return documentId;
    };

    // Two auto-approvable (gates pass, high confidence), one gate failure (TOTAL_MISMATCH).
    await seedExtraction({ canAutoApprove: true, overallConfidence: '0.9000', fieldConfidence: 0.9 });
    await seedExtraction({ canAutoApprove: true, overallConfidence: '0.9000', fieldConfidence: 0.9 });
    await seedExtraction({ canAutoApprove: false, overallConfidence: '0.9000', fieldConfidence: 0.9, issueCode: 'TOTAL_MISMATCH' });

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/documents.accuracyTelemetry?input=${encodeURIComponent(JSON.stringify({ days: 30 }))}`,
      cookies: { '__Host-session': sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const telemetry = asSuccess(response.json()) as { documentCount: number; autoApprovalRate: number; issueFrequency: { code: string; count: number }[] };
    expect(telemetry.documentCount).toBe(3);
    expect(telemetry.autoApprovalRate).toBeCloseTo(2 / 3, 5);
    expect(telemetry.issueFrequency).toEqual([{ code: 'TOTAL_MISMATCH', severity: 'BLOCK', count: 1 }]);
  });

  it('accuracyTelemetry is genuinely org-scoped — one org\'s extractions never appear in another org\'s telemetry', async () => {
    const orgA = await setUpOrgWithStore();
    const orgB = await setUpOrgWithStore();

    const requestResponse = await app.inject({ method: 'POST', url: '/trpc/documents.requestUpload', payload: { storeId: orgA.storeId }, cookies: { '__Host-session': orgA.sessionCookie } });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: REAL_PDF_BYTES });
    const confirmResponse = await app.inject({ method: 'POST', url: '/trpc/documents.confirmUpload', payload: { storeId: orgA.storeId, key }, cookies: { '__Host-session': orgA.sessionCookie } });
    const { documentId } = asSuccess(confirmResponse.json()) as { documentId: string };
    await db.insert(documentExtractions).values({
      id: generateId(),
      organizationId: orgA.organizationId,
      documentId,
      provider: 'gemini',
      modelVersion: 'flash-lite-v1',
      promptVersion: '1',
      fields: {},
      lines: [],
      validation: { issues: [], canAutoApprove: true },
      overallConfidence: '0.9000',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/trpc/documents.accuracyTelemetry?input=${encodeURIComponent(JSON.stringify({ days: 30 }))}`,
      cookies: { '__Host-session': orgB.sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const telemetry = asSuccess(response.json()) as { documentCount: number; autoApprovalRate: number | null };
    expect(telemetry.documentCount).toBe(0);
    expect(telemetry.autoApprovalRate).toBeNull();
  });
});
