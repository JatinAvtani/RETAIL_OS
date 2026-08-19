import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { savedCsvColumnMappings } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * the plan's "save the column mapping per tenant so repeat imports are one click." One row
 * per (organization, label) — `upsert` by label rather than a separate create/update pair, since
 * re-saving under the same label (a tenant tweaking their own saved mapping) is the common case,
 * not an error.
 */
export class SavedCsvMappingRepository extends TenantScopedRepository<typeof savedCsvColumnMappings> {
  constructor(db: Db, organizationId: string) {
    super(db, savedCsvColumnMappings, organizationId);
  }

  async upsert(label: string, columnMapping: Record<string, string | undefined>) {
    const rows = await this.runScoped((db) =>
      db
        .insert(savedCsvColumnMappings)
        .values({ id: generateId(), organizationId: this.organizationId, label, columnMapping })
        .onConflictDoUpdate({
          target: [savedCsvColumnMappings.organizationId, savedCsvColumnMappings.label],
          set: { columnMapping, updatedAt: new Date() },
        })
        .returning()
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Saved CSV mapping upsert returned no row.');
    }
    return row;
  }

  async findAllForOrganization() {
    return this.runScoped((db, scopedWhere) => db.select().from(savedCsvColumnMappings).where(scopedWhere()));
  }

  async findByLabel(label: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(savedCsvColumnMappings)
        .where(scopedWhere(eq(savedCsvColumnMappings.label, label)))
    );
    return rows[0] ?? null;
  }
}
