import { integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { idColumn, timestamps } from './columns';

export const catalogCsvImportStatusEnum = pgEnum('catalog_csv_import_status', ['UPLOADED', 'MAPPED', 'IMPORTED', 'FAILED']);
export const catalogCsvImportTypeEnum = pgEnum('catalog_csv_import_type', ['PRODUCT', 'SUPPLIER', 'RECIPE']);

/**
 * The same UPLOADED -> MAPPED -> IMPORTED|FAILED state machine `sales_csv_imports` established,
 * parameterized by `importType` rather than duplicated per entity — a product-catalog import and a
 * supplier-catalog import share every mechanical step (upload, detect headers, map columns, preview,
 * commit); only the column-mapping shape and the commit-time repository calls differ, both of which
 * already vary per caller in code, not per row here. Deliberately a SEPARATE table from
 * `sales_csv_imports`, not a shared one with a wider discriminator: sales-transaction import history
 * and master/catalog-data import history are different domains with different downstream consumers,
 * and no code anywhere needs to query across both kinds in one place.
 */
export const catalogCsvImports = pgTable('catalog_csv_imports', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  importType: catalogCsvImportTypeEnum('import_type').notNull(),
  storageKey: text('storage_key').notNull(),
  status: catalogCsvImportStatusEnum('status').notNull().default('UPLOADED'),
  detectedHeaders: jsonb('detected_headers'),
  columnMapping: jsonb('column_mapping'),
  totalRowCount: integer('total_row_count'),
  importedRowCount: integer('imported_row_count'),
  skippedRowCount: integer('skipped_row_count'),
  errorSummary: text('error_summary'),
  uploadedByUserId: uuid('uploaded_by_user_id'),
  ...timestamps,
});

/**
 * Same "save the mapping per tenant so repeat imports are one click" shape as
 * `saved_csv_column_mappings`, kept separate (not shared) because a label like "Toast export" only
 * makes sense within one import type — reusing a product-import mapping's column names for a
 * supplier import would silently misfire.
 */
export const savedCatalogCsvColumnMappings = pgTable('saved_catalog_csv_column_mappings', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  importType: catalogCsvImportTypeEnum('import_type').notNull(),
  label: text('label').notNull(),
  columnMapping: jsonb('column_mapping').notNull(),
  ...timestamps,
});
