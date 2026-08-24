import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { catalogCsvImports, type catalogCsvImportStatusEnum, type catalogCsvImportTypeEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type CatalogCsvImportStatus = (typeof catalogCsvImportStatusEnum.enumValues)[number];
export type CatalogCsvImportType = (typeof catalogCsvImportTypeEnum.enumValues)[number];

/**
 * `catalog_csv_imports` walks the exact same `UPLOADED -> MAPPED -> IMPORTED | FAILED` state
 * machine `CsvImportRepository` (sales CSV import) established — same shape, parameterized by
 * `importType` instead of a second parallel class, since the lifecycle mechanics are identical and
 * only the commit-time interpretation of a row differs (handled by the caller, not this repository).
 */
export class CatalogCsvImportRepository extends TenantScopedRepository<typeof catalogCsvImports> {
  constructor(db: Db, organizationId: string) {
    super(db, catalogCsvImports, organizationId);
  }

  async create(input: { importType: CatalogCsvImportType; storageKey: string; uploadedByUserId?: string }) {
    const rows = await this.runScoped((db) =>
      db
        .insert(catalogCsvImports)
        .values({
          id: generateId(),
          organizationId: this.organizationId,
          importType: input.importType,
          storageKey: input.storageKey,
          ...(input.uploadedByUserId !== undefined ? { uploadedByUserId: input.uploadedByUserId } : {}),
        })
        .returning()
    );
    const created = rows[0];
    if (!created) {
      throw new Error('Catalog CSV import insert returned no row.');
    }
    return created;
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(catalogCsvImports)
        .where(scopedWhere(eq(catalogCsvImports.id, id)))
    );
    return rows[0] ?? null;
  }

  async findAllForOrganization(importType?: CatalogCsvImportType) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(catalogCsvImports)
        .where(scopedWhere(importType !== undefined ? eq(catalogCsvImports.importType, importType) : undefined))
    );
  }

  /** Records the detected headers straight after upload confirmation — still `UPLOADED`, the human hasn't mapped anything yet. */
  async recordDetectedHeaders(id: string, detectedHeaders: { headers: string[]; sampleRows: string[][]; delimiter: string }) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(catalogCsvImports)
        .set({ detectedHeaders, updatedAt: new Date() })
        .where(scopedWhere(eq(catalogCsvImports.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  /** The human's confirmed column mapping (I9) — moves the row to `MAPPED`, ready for a commit function to actually parse and write rows. */
  async recordColumnMapping(id: string, columnMapping: Record<string, string | undefined>) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(catalogCsvImports)
        .set({ columnMapping, status: 'MAPPED' satisfies CatalogCsvImportStatus, updatedAt: new Date() })
        .where(scopedWhere(eq(catalogCsvImports.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  async recordImportResult(id: string, result: { totalRowCount: number; importedRowCount: number; skippedRowCount: number }) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(catalogCsvImports)
        .set({
          status: 'IMPORTED' satisfies CatalogCsvImportStatus,
          totalRowCount: result.totalRowCount,
          importedRowCount: result.importedRowCount,
          skippedRowCount: result.skippedRowCount,
          updatedAt: new Date(),
        })
        .where(scopedWhere(eq(catalogCsvImports.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  async recordFailure(id: string, errorSummary: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(catalogCsvImports)
        .set({ status: 'FAILED' satisfies CatalogCsvImportStatus, errorSummary, updatedAt: new Date() })
        .where(scopedWhere(eq(catalogCsvImports.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }
}

/**
 * `label` uniqueness is per `(organization, importType)`, not just `(organization, label)` — a
 * "Toast export" label means one thing for a product import and a genuinely different thing for a
 * supplier import, so both fields participate in `upsert`'s conflict target.
 */
export class SavedCatalogCsvMappingRepository extends TenantScopedRepository<typeof schema.savedCatalogCsvColumnMappings> {
  constructor(db: Db, organizationId: string) {
    super(db, schema.savedCatalogCsvColumnMappings, organizationId);
  }

  async upsert(importType: CatalogCsvImportType, label: string, columnMapping: Record<string, string | undefined>) {
    const rows = await this.runScoped((db) =>
      db
        .insert(schema.savedCatalogCsvColumnMappings)
        .values({ id: generateId(), organizationId: this.organizationId, importType, label, columnMapping })
        .onConflictDoUpdate({
          target: [schema.savedCatalogCsvColumnMappings.organizationId, schema.savedCatalogCsvColumnMappings.importType, schema.savedCatalogCsvColumnMappings.label],
          set: { columnMapping, updatedAt: new Date() },
        })
        .returning()
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Saved catalog CSV mapping upsert returned no row.');
    }
    return row;
  }

  async findAllForOrganization(importType: CatalogCsvImportType) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(schema.savedCatalogCsvColumnMappings)
        .where(scopedWhere(eq(schema.savedCatalogCsvColumnMappings.importType, importType)))
    );
  }

  async findByLabel(importType: CatalogCsvImportType, label: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(schema.savedCatalogCsvColumnMappings)
        .where(scopedWhere(and(eq(schema.savedCatalogCsvColumnMappings.importType, importType), eq(schema.savedCatalogCsvColumnMappings.label, label))))
    );
    return rows[0] ?? null;
  }
}
