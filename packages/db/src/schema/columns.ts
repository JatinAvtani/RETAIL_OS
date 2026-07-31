import { integer, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Universal column conventions (spec 08 SS8.2), factored so every tenant table applies them the
 * same way. `id` has no DB-side default — see packages/domain/src/primitives/id.ts for why
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
