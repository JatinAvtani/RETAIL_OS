import { loadEnv } from '@retailos/config';

// Makes the README's own migrate step work on a fresh clone instead of throwing
// `DATABASE_URL is required`. ES imports hoist above this call, which is safe here only because
// neither `./client` nor the migrator reads `process.env` at module scope — `createDb` takes its
// connection string as an argument. This file's own `process.env` read happens below, after it.
loadEnv();

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required to run migrations');
}

const { client, db } = createDb(connectionString);

await migrate(db, { migrationsFolder: './drizzle' });
await client.end();

console.log('Migrations applied.');
