import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { UnitRepository } from './unit-repository';

const CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ??
  'postgresql://retailos_app:retailos_app_local_only@localhost:5432/retailos';

describe('UnitRepository', () => {
  let client: ReturnType<typeof postgres>;
  let repo: UnitRepository;

  beforeAll(() => {
    client = postgres(CONNECTION_STRING);
    repo = new UnitRepository(drizzle(client, { schema }));
  });

  afterAll(async () => {
    await client.end();
  });

  it('finds the seeded global unit vocabulary', async () => {
    const all = await repo.findAll();
    const codes = all.map((u) => u.code).sort();
    expect(codes).toEqual(['each', 'g', 'kg', 'l', 'mg', 'ml']);
  });

  it('marks exactly one base unit per dimension', async () => {
    const all = await repo.findAll();
    const baseByDimension = new Map<string, string[]>();
    for (const unit of all.filter((u) => u.isBase)) {
      baseByDimension.set(unit.dimension, [...(baseByDimension.get(unit.dimension) ?? []), unit.code]);
    }
    expect(baseByDimension.get('MASS')).toEqual(['g']);
    expect(baseByDimension.get('VOLUME')).toEqual(['ml']);
    expect(baseByDimension.get('COUNT')).toEqual(['each']);
  });

  it('findByCode returns the matching unit', async () => {
    const kg = await repo.findByCode('kg');
    expect(kg?.dimension).toBe('MASS');
    expect(kg?.isBase).toBe(false);
  });

  it('findByCode returns null for an unknown code', async () => {
    const result = await repo.findByCode('does-not-exist');
    expect(result).toBeNull();
  });
});
