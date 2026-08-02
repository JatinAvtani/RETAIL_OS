import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { units } from '../schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Not a TenantScopedRepository: units is a global lookup table (no organization_id column, no
 * RLS), the same category as organizations/users — see schema comments on units.ts for why.
 * Every organization reads the identical fixed vocabulary (mg/g/kg/ml/l/each, seeded in
 * drizzle/0008_units_and_conversions.sql), so there is no tenant boundary here to enforce.
 */
export class UnitRepository {
  constructor(private readonly db: Db) {}

  async findAll() {
    return this.db.select().from(units);
  }

  async findByCode(code: string) {
    const rows = await this.db.select().from(units).where(eq(units.code, code));
    return rows[0] ?? null;
  }
}
