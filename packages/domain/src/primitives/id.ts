import { v7 as uuidv7 } from 'uuid';

/**
 * UUID v7 (time-ordered), not v4. Spec 08 SS8.2 calls for v7 specifically so that primary-key
 * insert order stays close to index order at volume — v4's randomness causes B-tree
 * fragmentation. Postgres 16 has no native v7 generator (gen_random_uuid() is v4; native uuidv7()
 * arrives in PG18), so IDs are generated here, in application code, and passed explicitly on
 * insert rather than relying on a DB-side DEFAULT.
 */
export const generateId = (): string => uuidv7();
