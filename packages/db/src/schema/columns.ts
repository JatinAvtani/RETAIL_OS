import { customType, integer, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Universal column conventions, factored so every tenant table applies them the same way. `id`
 * has no DB-side default — see packages/domain/src/primitives/id.ts for why
 * (UUID v7, generated in application code, not gen_random_uuid()'s v4).
 */
export const idColumn = () => uuid('id').primaryKey();

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

export const optimisticVersion = {
  version: integer('version').notNull().default(1),
};

/**
 * 009-18 — pgvector's `vector(N)` type has no first-class Drizzle 0.36 representation, so this is a
 * thin `customType`: the app never reads/writes a `vector` column through the typed query builder
 * (every real embedding write/read goes through raw `sql`, since similarity operators like `<=>`
 * have no builder representation either) — this exists only so `document_embeddings.embedding` can
 * be DECLARED in the schema file (for `drizzle-kit`'s own introspection/migration-diffing to stay
 * aware of the column), not so application code queries through it.
 */
export const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dimensions})`,
    toDriver: (value: number[]) => `[${value.join(',')}]`,
    fromDriver: (value: string) => value.slice(1, -1).split(',').map(Number),
  })(name);
