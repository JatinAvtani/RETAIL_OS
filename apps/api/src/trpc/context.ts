import { createDb } from '@retailos/db';
import { createRedisClient, SessionStore } from '@retailos/session';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';

/**
 * One connection pool / Redis client for the process lifetime, not one per request — both
 * `createDb` and `createRedisClient` wrap long-lived connections internally. Exported (not just
 * used locally) so `server.ts` can wire the same instances into the plain Fastify OAuth routes,
 * which sit outside the tRPC context entirely (a browser redirect, not a tRPC procedure call).
 */
export const { db } = createDb(
  process.env.DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos'
);
export const redis: ReturnType<typeof createRedisClient> = createRedisClient(
  process.env.REDIS_URL ?? 'redis://localhost:6379'
);
export const sessionStore = new SessionStore(redis);

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
  req,
  res,
});

export type Context = Awaited<ReturnType<typeof createContext>>;
