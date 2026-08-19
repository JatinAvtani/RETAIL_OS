import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { salesCsvImports, type csvImportStatusEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type CsvImportStatus = (typeof csvImportStatusEnum.enumValues)[number];

/**
 * earlier work's state-machine repository: `sales_csv_imports` walks
 * `UPLOADED -> MAPPED -> IMPORTED | FAILED`, same shape as `PosConnectionRepository`'s
 * `status`/`lastError` pattern (a plain status column + a text error field, not a separate error
 * table) — this codebase's established precedent for "one row's own health," not a growing side
 * table.
 */
export class CsvImportRepository extends TenantScopedRepository<typeof salesCsvImports> {
  constructor(db: Db, organizationId: string) {
    super(db, salesCsvImports, organizationId);
  }

  async create(input: { storeId: string; storageKey: string; uploadedByUserId?: string }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(salesCsvImports)
        .values({
          id: generateId(),
          organizationId: this.organizationId,
          storeId: input.storeId,
          storageKey: input.storageKey,
          ...(input.uploadedByUserId !== undefined ? { uploadedByUserId: input.uploadedByUserId } : {}),
        })
        .returning()
    );
    const created = rows[0];
    if (!created) {
      throw new Error('CSV import insert returned no row.');
    }
    return created;
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(salesCsvImports)
        .where(scopedWhere(eq(salesCsvImports.id, id)))
    );
    return rows[0] ?? null;
  }

  async findAllForOrganization() {
    return this.runScoped((db, scopedWhere) => db.select().from(salesCsvImports).where(scopedWhere()));
  }

  /** Records the detected headers straight after upload confirmation — still `UPLOADED`, the human hasn't mapped anything yet. */
  async recordDetectedHeaders(id: string, detectedHeaders: { headers: string[]; sampleRows: string[][]; delimiter: string }) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(salesCsvImports)
        .set({ detectedHeaders, updatedAt: new Date() })
        .where(scopedWhere(eq(salesCsvImports.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  /** The human's confirmed column mapping (I9) — moves the row to `MAPPED`, ready for `commitImport` to actually parse and write rows. */
  async recordColumnMapping(id: string, columnMapping: Record<string, string | undefined>) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(salesCsvImports)
        .set({ columnMapping, status: 'MAPPED' satisfies CsvImportStatus, updatedAt: new Date() })
        .where(scopedWhere(eq(salesCsvImports.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  async recordImportResult(
    id: string,
    result: { totalRowCount: number; importedRowCount: number; quarantinedRowCount: number; skippedRowCount: number }
  ) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(salesCsvImports)
        .set({
          status: 'IMPORTED' satisfies CsvImportStatus,
          totalRowCount: result.totalRowCount,
          importedRowCount: result.importedRowCount,
          quarantinedRowCount: result.quarantinedRowCount,
          skippedRowCount: result.skippedRowCount,
          updatedAt: new Date(),
        })
        .where(scopedWhere(eq(salesCsvImports.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  async recordFailure(id: string, errorSummary: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(salesCsvImports)
        .set({ status: 'FAILED' satisfies CsvImportStatus, errorSummary, updatedAt: new Date() })
        .where(scopedWhere(eq(salesCsvImports.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }
}
