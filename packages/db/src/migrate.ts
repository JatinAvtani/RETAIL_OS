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
