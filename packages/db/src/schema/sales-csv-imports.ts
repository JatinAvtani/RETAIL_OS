import { integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { idColumn, timestamps } from './columns';

export const csvImportStatusEnum = pgEnum('csv_import_status', ['UPLOADED', 'MAPPED', 'IMPORTED', 'FAILED']);

/**
 * 006-10 (plan.md Phase 5): the state machine one CSV upload moves through — `UPLOADED` (file
 * confirmed in object storage, headers detected) → `MAPPED` (a human confirmed which column is
 * which field) → `IMPORTED` (rows written) or `FAILED`. Modeled as a real table, not implicit
 * client-side state between two independent requests, matching `stock_counts`' own reasoning
 * (`DRAFT → IN_PROGRESS → ...`): the file itself lives in object storage (already tenant-prefixed,
 * already has the presigned-URL pattern from `packages/storage`/`products.requestImageUpload`) —
 * this table is the lifecycle + audit trail on top of it, not a duplicate copy of the file's bytes.
 *
 * `detectedHeaders`/`columnMapping` are jsonb, matching `webhook_events.payload`'s precedent for
 * vendor/user-shaped detail this codebase never queries into, only reads back whole.
 */
export const salesCsvImports = pgTable('sales_csv_imports', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  storeId: uuid('store_id')
    .notNull()
    .references(() => stores.id),
  storageKey: text('storage_key').notNull(),
  status: csvImportStatusEnum('status').notNull().default('UPLOADED'),
  detectedHeaders: jsonb('detected_headers'),
  columnMapping: jsonb('column_mapping'),
  totalRowCount: integer('total_row_count'),
  importedRowCount: integer('imported_row_count'),
  quarantinedRowCount: integer('quarantined_row_count'),
  skippedRowCount: integer('skipped_row_count'),
  errorSummary: text('error_summary'),
  uploadedByUserId: uuid('uploaded_by_user_id'),
  ...timestamps,
});

/**
 * plan.md: "save the column mapping per tenant so repeat imports are one click." Keyed by a
 * human-chosen label (e.g. "Toast export", "Lightspeed weekly") rather than inferred from the file
 * itself — a tenant's exports from the same POS keep the same header row across uploads in
 * practice, but nothing in this codebase should assume that; the label is the explicit, human
 * intent this mapping applies to, matching I9 (a human names and confirms it, never inferred).
 */
export const savedCsvColumnMappings = pgTable('saved_csv_column_mappings', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  label: text('label').notNull(),
  columnMapping: jsonb('column_mapping').notNull(),
  ...timestamps,
});
