import { loadEnv } from '@retailos/config';

// Makes the README's own migrate step work on a fresh clone instead of throwing
// `DATABASE_URL is required`. ES imports hoist above this call, which is safe here only because
// neither `./client` nor the migrator reads `process.env` at module scope — `createDb` takes its
// connection string as an argument. This file's own `process.env` read happens below, after it.
loadEnv();

import { readFileSync } from 'node:fs';
import postgres from 'postgres';

/**
 * Runs drizzle/0002_concurrent_indexes.sql — deliberately NOT via Drizzle's migrate() (see that
 * file and 0001_rls_and_constraints.sql for why: CREATE INDEX CONCURRENTLY cannot run inside a
 * transaction block, and migrate() always wraps every migration in one transaction with no
 * per-file opt-out). Not tracked in Drizzle's __drizzle_migrations table either, since it isn't
 * read through readMigrationFiles (that only reads files listed in meta/_journal.json, and this
 * one deliberately isn't).
 *
 * Each statement runs individually, unprepared (`.simple()`), because CONCURRENTLY also cannot
 * run as a prepared/extended-protocol statement in some drivers — plain simple-query mode avoids
 * that entirely. Idempotent: every statement is IF NOT EXISTS, so re-running this is safe.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required to run migrations');
}

const sql = postgres(connectionString, { max: 1 });

const filePath = new URL('../drizzle/0002_concurrent_indexes.sql', import.meta.url);
const fileContents = readFileSync(filePath, 'utf-8');
const statements = fileContents
  .split('\n')
  .filter((line) => !line.trim().startsWith('--') && line.trim().length > 0);

for (const statement of statements) {
  console.log(`Running: ${statement.slice(0, 80)}...`);
  await sql.unsafe(statement);
}

await sql.end();
console.log('Concurrent index migration applied.');
