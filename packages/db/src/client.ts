import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';

/**
 * Connects as the application role, never as the `postgres` superuser. A superuser silently
 * bypasses RLS regardless of ENABLE/FORCE (spec 08 SS8.1) — this is what makes RLS an actual
 * guarantee rather than a policy that only holds by convention.
 */
export const createDb = (connectionString: string) => {
  const client = postgres(connectionString);
  return { client, db: drizzle(client, { schema }) };
};
