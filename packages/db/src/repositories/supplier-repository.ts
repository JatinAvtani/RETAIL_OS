import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';
import { suppliers } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

export class SupplierRepository extends TenantScopedRepository<typeof suppliers> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, suppliers, organizationId);
  }

  async findAll() {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(suppliers)
        .where(scopedWhere(isNull(suppliers.deletedAt)))
    );
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(suppliers)
        .where(scopedWhere(and(eq(suppliers.id, id), isNull(suppliers.deletedAt))))
    );
    return rows[0] ?? null;
  }

  async create(input: {
    id: string;
    name: string;
    paymentTerms?: string;
    leadTimeDaysContracted?: number;
    minOrderValue?: string;
  }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(suppliers)
        .values({
          id: input.id,
          organizationId: this.organizationId,
          name: input.name,
          paymentTerms: input.paymentTerms ?? null,
          leadTimeDaysContracted: input.leadTimeDaysContracted ?? null,
          minOrderValue: input.minOrderValue ?? null,
        })
        .returning()
    );
    const created = rows[0];
    if (!created) {
      throw new Error('Supplier insert returned no row.');
    }
    return created;
  }

  /**
   * `leadTimeDaysMeasured` is reality, distinct from the contracted promise — updated separately
   * as real receipts accumulate (EPIC-006+), never derived from `leadTimeDaysContracted`.
   */
  async recordMeasuredLeadTime(id: string, days: number) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(suppliers)
        .set({ leadTimeDaysMeasured: days })
        .where(scopedWhere(eq(suppliers.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }
}
