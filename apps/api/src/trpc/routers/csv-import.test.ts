import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  hashPassword,
  memberships,
  organizations,
  outboxEvents,
  posItems,
  salesCsvImports,
  salesTransactionLines,
  salesTransactions,
  savedCsvColumnMappings,
  stockLevels,
  stockMovements,
  stores,
  unmappedSales,
  lots,
  users,
} from '@retailos/db';
import { createRedisClient } from '@retailos/session';
import { generateId } from '@retailos/domain';
import { buildCsvImportKey } from '@retailos/storage';
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

const SIMPLE_CSV = 'occurred_at,item,qty,price\n2026-08-01,Cappuccino,2,4.50\n2026-08-02,Croissant,1,3.25\n';
const REAL_MAPPING = { occurredAt: 'occurred_at', posItemName: 'item', quantity: 'qty', unitPrice: 'price' };

/**
 * 006-10: real Postgres + real Redis + real MinIO + real HTTP, proving the full upload -> detect
 * headers -> map columns -> commit flow end to end — the same discipline every other 006-0x task
 * has used (real bytes through a real presigned URL, never a mocked upload).
 */
describe('csvImport router', () => {
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
    for (const userId of createdUserIds) {
      const tokens = await redis.smembers(`user-sessions:${userId}`);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => `session:${t}`), `user-sessions:${userId}`);
      }
      await db.delete(memberships).where(eq(memberships.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    for (const orgId of createdOrgIds) {
      await db.delete(unmappedSales).where(eq(unmappedSales.organizationId, orgId));
      await db.delete(outboxEvents).where(eq(outboxEvents.organizationId, orgId));
      await db.delete(stockMovements).where(eq(stockMovements.organizationId, orgId));
      await db.delete(stockLevels).where(eq(stockLevels.organizationId, orgId));
      await db.delete(lots).where(eq(lots.organizationId, orgId));
      await db.delete(salesTransactionLines).where(eq(salesTransactionLines.organizationId, orgId));
      await db.delete(salesTransactions).where(eq(salesTransactions.organizationId, orgId));
      await db.delete(posItems).where(eq(posItems.organizationId, orgId));
      await db.delete(salesCsvImports).where(eq(salesCsvImports.organizationId, orgId));
      await db.delete(savedCsvColumnMappings).where(eq(savedCsvColumnMappings.organizationId, orgId));
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
      name: `CSV Import Test Org ${organizationId}`,
      slug: `csv-import-test-${organizationId}`,
      baseCurrency: 'USD',
    });
    const storeId = generateId();
    await db.insert(stores).values({ id: storeId, organizationId, name: 'Main Store', timezone: 'America/New_York' });

    const email = uniqueEmail('csv-import');
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

  /** Runs the real requestUpload -> real PUT -> confirmUpload sequence, returning the resulting importId + detected headers. */
  const uploadCsv = async (storeId: string, sessionCookie: string, csvText: string) => {
    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };

    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: csvText });

    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.confirmUpload',
      payload: { storeId, key },
      cookies: { '__Host-session': sessionCookie },
    });
    return { confirmResponse, key };
  };

  it('rejects an unauthenticated requestUpload with 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/trpc/csvImport.requestUpload', payload: { storeId: generateId() } });
    expect(response.statusCode).toBe(401);
  });

  it('requestUpload returns a presigned URL that accepts a real PUT', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();
    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(requestResponse.statusCode).toBe(200);
    const { uploadUrl } = asSuccess(requestResponse.json()) as { uploadUrl: string };
    const putResponse = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: SIMPLE_CSV });
    expect(putResponse.ok).toBe(true);
  });

  it('confirmUpload creates the import row and detects real headers from the uploaded bytes', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();
    const { confirmResponse } = await uploadCsv(storeId, sessionCookie, SIMPLE_CSV);

    expect(confirmResponse.statusCode).toBe(200);
    const body = asSuccess(confirmResponse.json()) as { importId: string; headers: string[]; sampleRows: string[][] };
    expect(body.headers).toEqual(['occurred_at', 'item', 'qty', 'price']);
    expect(body.sampleRows).toEqual([
      ['2026-08-01', 'Cappuccino', '2', '4.50'],
      ['2026-08-02', 'Croissant', '1', '3.25'],
    ]);

    const [row] = await db.select().from(salesCsvImports).where(eq(salesCsvImports.id, body.importId));
    expect(row?.status).toBe('UPLOADED');
  });

  it('confirmUpload rejects an object whose real bytes look like an XLSX file, regardless of the declared content-type', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();
    const requestResponse = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.requestUpload',
      payload: { storeId },
      cookies: { '__Host-session': sessionCookie },
    });
    const { uploadUrl, key } = asSuccess(requestResponse.json()) as { uploadUrl: string; key: string };
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: zipBytes });

    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.confirmUpload',
      payload: { storeId, key },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(confirmResponse.statusCode).toBe(400);
    expect(asError(confirmResponse.json()).message).toMatch(/excel|binary/i);
  });

  it('confirmUpload rejects a key not prefixed with the caller\'s own organizationId', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.confirmUpload',
      payload: { storeId, key: buildCsvImportKey('some-other-org', generateId()) },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('submitColumnMapping moves the import to MAPPED and can save a reusable per-tenant mapping', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();
    const { confirmResponse } = await uploadCsv(storeId, sessionCookie, SIMPLE_CSV);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

    const mapResponse = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.submitColumnMapping',
      payload: { importId, columnMapping: REAL_MAPPING, saveAsLabel: 'My POS export' },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(mapResponse.statusCode).toBe(200);

    const [row] = await db.select().from(salesCsvImports).where(eq(salesCsvImports.id, importId));
    expect(row?.status).toBe('MAPPED');

    const savedResponse = await app.inject({
      method: 'GET',
      url: '/trpc/csvImport.savedMappings',
      cookies: { '__Host-session': sessionCookie },
    });
    const saved = asSuccess(savedResponse.json()) as unknown as Array<{ label: string }>;
    expect(saved.some((m) => m.label === 'My POS export')).toBe(true);
  });

  it('commit imports both rows into sales_transactions with pos_items created and quarantines them (no menu item mapped yet), never double-counting on a second commit attempt', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();
    const { confirmResponse } = await uploadCsv(storeId, sessionCookie, SIMPLE_CSV);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

    await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.submitColumnMapping',
      payload: { importId, columnMapping: REAL_MAPPING },
      cookies: { '__Host-session': sessionCookie },
    });

    const commitResponse = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.commit',
      payload: { importId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(commitResponse.statusCode).toBe(200);
    const result = asSuccess(commitResponse.json()) as { totalRowCount: number; importedRowCount: number; quarantinedRowCount: number; skippedRowCount: number };
    expect(result.totalRowCount).toBe(2);
    expect(result.importedRowCount).toBe(2);
    expect(result.quarantinedRowCount).toBe(2); // no pos_items -> menu_item mapping exists yet
    expect(result.skippedRowCount).toBe(0);

    const txRows = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, (await db.select().from(salesCsvImports).where(eq(salesCsvImports.id, importId)))[0]!.organizationId));
    expect(txRows).toHaveLength(2);
    expect(txRows.every((t) => t.source === 'csv')).toBe(true);

    const [importRow] = await db.select().from(salesCsvImports).where(eq(salesCsvImports.id, importId));
    expect(importRow?.status).toBe('IMPORTED');

    const posItemRows = await db.select().from(posItems).where(eq(posItems.organizationId, importRow!.organizationId));
    expect(posItemRows.map((p) => p.name).sort()).toEqual(['Cappuccino', 'Croissant']);

    const unmappedRows = await db.select().from(unmappedSales).where(eq(unmappedSales.organizationId, importRow!.organizationId));
    expect(unmappedRows).toHaveLength(2); // revenue counted via unmapped_sales.revenue, consumption never posted, nothing silently dropped

    // Re-committing the same import (idempotency proof — the same row content hashes are re-derived from the same file, onConflictDoNothing makes this a genuine no-op)
    const secondCommit = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.commit',
      payload: { importId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(secondCommit.statusCode).toBe(200);
    const secondResult = asSuccess(secondCommit.json()) as { importedRowCount: number };
    expect(secondResult.importedRowCount).toBe(0); // both rows already exist — no double-counted revenue

    const txRowsAfterSecondCommit = await db.select().from(salesTransactions).where(eq(salesTransactions.organizationId, importRow!.organizationId));
    expect(txRowsAfterSecondCommit).toHaveLength(2); // still exactly 2, not 4
  });

  it('commit rejects an import that has not been mapped yet (still UPLOADED)', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();
    const { confirmResponse } = await uploadCsv(storeId, sessionCookie, SIMPLE_CSV);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

    const commitResponse = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.commit',
      payload: { importId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(commitResponse.statusCode).toBe(400);
    expect(asError(commitResponse.json()).message).toMatch(/MAPPED/);
  });

  it('a row with an unparseable cell is skipped (skippedRowCount), the rest of the file still imports', async () => {
    const { storeId, sessionCookie } = await setUpOrgWithStore();
    const csvWithBadRow = 'occurred_at,item,qty,price\nnot-a-date,Bad Row,1,3.00\n2026-08-01,Good Row,1,3.00\n';
    const { confirmResponse } = await uploadCsv(storeId, sessionCookie, csvWithBadRow);
    const { importId } = asSuccess(confirmResponse.json()) as { importId: string };

    await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.submitColumnMapping',
      payload: { importId, columnMapping: REAL_MAPPING },
      cookies: { '__Host-session': sessionCookie },
    });

    const commitResponse = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.commit',
      payload: { importId },
      cookies: { '__Host-session': sessionCookie },
    });
    const result = asSuccess(commitResponse.json()) as { totalRowCount: number; importedRowCount: number; skippedRowCount: number };
    expect(result.totalRowCount).toBe(2);
    expect(result.importedRowCount).toBe(1);
    expect(result.skippedRowCount).toBe(1);
  });

  it('a real DB lookup rejects a storeId from a different organization on requestUpload', async () => {
    const { storeId: otherOrgStoreId } = await setUpOrgWithStore();
    const { sessionCookie } = await setUpOrgWithStore();

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/csvImport.requestUpload',
      payload: { storeId: otherOrgStoreId },
      cookies: { '__Host-session': sessionCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
