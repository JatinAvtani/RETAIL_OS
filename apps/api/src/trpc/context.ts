import { createDb } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import { createStorageClient } from '@retailos/storage';
import { createExtractionQueue, createQueueRedisConnection } from '@retailos/queue';
import type { Queue } from 'bullmq';
import type { ExtractionJobData } from '@retailos/queue';
import type { S3Client } from '@aws-sdk/client-s3';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { createAuthRateLimiters } from '../auth/rate-limit';

export const PRODUCT_IMAGES_BUCKET = 'retailos-product-images';
export const SALES_CSV_IMPORTS_BUCKET = 'retailos-sales-csv-imports';
export const DOCUMENTS_BUCKET = 'retailos-documents';

/**
 * One connection pool / Redis client for the process lifetime, not one per request — both
 * `createDb` and `createRedisClient` wrap long-lived connections internally. Exported (not just
 * used locally) so `server.ts` can wire the same instances into the plain Fastify OAuth routes,
 * which sit outside the tRPC context entirely (a browser redirect, not a tRPC procedure call).
 *
 * `APP_DATABASE_URL` (falling back to `DATABASE_URL`) — NEVER just `DATABASE_URL` alone — because
 * this connection is the app's real runtime connection and must always be the RLS-scoped
 * `retailos_app` role, never a superuser. In local dev/production `DATABASE_URL` naturally IS
 * that connection, so the fallback is transparent. In CI, `DATABASE_URL` is the migration/seed
 * admin connection (superuser, needed for DDL and cross-tenant test seeding) — a real,
 * previously-undetected gap found during 004-15: `ci.yml` set `DATABASE_URL` to the superuser for
 * the whole job, which meant every `apps/api` test, including the entire cross-tenant suite, ran
 * against a connection that bypasses RLS (`BYPASSRLS`) — RLS was never actually exercised in CI
 * for this app, only application-layer checks were. `ci.yml`'s test step now sets
 * `APP_DATABASE_URL` to the real `retailos_app` role explicitly for this reason.
 */
export const { db } = createDb(
  process.env.APP_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos'
);
export const redis: ReturnType<typeof createRedisClient> = createRedisClient(
  process.env.REDIS_URL ?? 'redis://localhost:6379'
);
export const sessionStore = new SessionStore(redis);
export const authRateLimiters = createAuthRateLimiters(redis);
export const storageClient: S3Client = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
  bucket: PRODUCT_IMAGES_BUCKET,
});

/**
 * 007-05: a dedicated Redis connection for BullMQ, separate from `redis` above (`packages/session`'s
 * client, used for sessions/rate-limiting) — BullMQ's own documented connection requirements
 * (`maxRetriesPerRequest: null`) are specific to its own use and shouldn't be forced onto the
 * session store's unrelated fast-fail expectations.
 */
export const extractionQueue: Queue<ExtractionJobData> = createExtractionQueue(
  createQueueRedisConnection(process.env.REDIS_URL ?? 'redis://localhost:6379')
);

/**
 * `req`/`res` are exposed so a procedure can read the session cookie or set/clear one — signup and
 * verify-email don't need this (unauthenticated), login does. There is no `authContext` here: it
 * isn't resolved eagerly from the cookie on every request, since most procedures today don't need
 * one and reading + validating a session on every request regardless of whether it's used would
 * be wasted Redis round trips. A procedure that needs an authenticated caller reads the cookie
 * itself via `ctx.req`/`ctx.sessionStore`, not through an ambient pre-resolved field.
 */
export const createContext = ({ req, res }: CreateFastifyContextOptions) => ({
  db,
  sessionStore,
  authRateLimiters,
  req,
  res,
});

export type Context = Awaited<ReturnType<typeof createContext>>;
