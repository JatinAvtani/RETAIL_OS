import { createDb } from '@retailos/db';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';

/**
 * One connection pool for the process lifetime, not one per request — `createDb` wraps a
 * `postgres` connection pool internally, so calling it per-request would open a new pool on every
 * call instead of reusing connections.
 */
const { db } = createDb(
  process.env.DATABASE_URL ?? 'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos'
);

/**
 * No session/auth data yet — every procedure using this context today is unauthenticated
 * (signup). Session resolution (reading the cookie, loading the SessionRecord from
 * packages/session, building an AuthContext from packages/authz) is added when the first
 * authenticated procedure needs it, not spec'd out speculatively here.
 */
export const createContext = (_opts: CreateFastifyContextOptions) => ({
  db,
});

export type Context = Awaited<ReturnType<typeof createContext>>;
