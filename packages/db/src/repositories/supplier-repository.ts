import { and, eq, isNull, sql } from 'drizzle-orm';
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

  /**
   * Case-insensitive EXACT name match — used by earlier work's validation gates to resolve an
   * extracted supplier name string to a real row without any fuzzy matching (that's earlier work's
   * job). Returns `null` on no match or more than one match; an ambiguous/ absent match means the
   * caller has no confirmed supplier to compare trailing prices against, which is a real
   * "unknown," not an error to guess through.
   */
  async findByExactName(name: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(suppliers)
        .where(scopedWhere(and(eq(sql`lower(${suppliers.name})`, name.trim().toLowerCase()), isNull(suppliers.deletedAt))))
    );
    return rows.length === 1 ? rows[0] : null;
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
   * The team-management-style "real editable record" gap the UI audit found: `create` existed,
   * but nothing let a caller change a supplier's contacts/terms/status after creation — every
   * field below is a real, spec'd column (07 ), not new scope. `leadTimeDaysContracted` is
   * editable here (the negotiated promise); `leadTimeDaysMeasured` deliberately is not — it's
   * derived from real receipts (see `recordMeasuredLeadTime`), never hand-edited.
   */
  async update(
    id: string,
    input: {
      name?: string;
      contacts?: { name: string; email?: string | undefined; phone?: string | undefined; role?: string | undefined }[] | null;
      paymentTerms?: string | null;
      leadTimeDaysContracted?: number | null;
      deliveryDays?: number[] | null;
      orderCutoffTime?: string | null;
      minOrderValue?: string | null;
      status?: 'active' | 'inactive';
    }
  ) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(suppliers)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.contacts !== undefined && { contacts: input.contacts }),
          ...(input.paymentTerms !== undefined && { paymentTerms: input.paymentTerms }),
          ...(input.leadTimeDaysContracted !== undefined && { leadTimeDaysContracted: input.leadTimeDaysContracted }),
          ...(input.deliveryDays !== undefined && { deliveryDays: input.deliveryDays }),
          ...(input.orderCutoffTime !== undefined && { orderCutoffTime: input.orderCutoffTime }),
          ...(input.minOrderValue !== undefined && { minOrderValue: input.minOrderValue }),
          ...(input.status !== undefined && { status: input.status }),
        })
        .where(scopedWhere(and(eq(suppliers.id, id), isNull(suppliers.deletedAt))))
        .returning()
    );
    return rows[0] ?? null;
  }

  /**
   * `leadTimeDaysMeasured` is reality, distinct from the contracted promise — updated separately
   * as real receipts accumulate, never derived from `leadTimeDaysContracted`.
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
