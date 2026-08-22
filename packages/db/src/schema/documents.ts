import { bigint, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { users } from './users';
import { documentUploadBatches } from './document-upload-batches';
import { idColumn, softDelete, timestamps, vector } from './columns';

/**
 * Supplier documents (mostly invoices) — the origin of the costing
 * chain. `type` and `source` match the design verbatim. `status` collapses the spec's own
 * pipeline prose and event list into one enum — `EXTRACTED`/`DUPLICATE_DETECTED` aren't modeled as
 * resting states because they're not: extraction completing is what produces a
 * `document_extractions` row (the document itself moves straight to `REVIEW_REQUIRED` or
 * `AUTO_APPROVED`), and duplicate detection is one of several validation-gate outcomes that route
 * to `REVIEW_REQUIRED` or `REJECTED`, not a distinct status of its own. `08-database-planning.md`
 * The database plan's own literal index example (`WHERE status = 'REVIEW_REQUIRED'`) confirms that value's name.
 */
export const documentTypeEnum = pgEnum('document_type', [
  'INVOICE',
  'DELIVERY_NOTE',
  'CREDIT_NOTE',
  'QUOTE',
  'CONTRACT',
  'CERTIFICATE',
  'OTHER',
]);

export const documentSourceEnum = pgEnum('document_source', ['UPLOAD', 'EMAIL', 'INTEGRATION']);

export const documentStatusEnum = pgEnum('document_status', [
  'UPLOADED',
  'PROCESSING',
  'REVIEW_REQUIRED',
  'AUTO_APPROVED',
  'APPROVED',
  'REJECTED',
  'POSTED',
]);

/**
 * The original file is immutable — a re-upload creates a new row (`version` + `supersedesId`), never
 * an overwrite. Soft-deleted ("Soft delete
 * + storage retention — legal/audit requirements"), unlike ledger tables which get no deletion path
 * at all. Store-scoped like `pos_items`/`sales_transactions` — an invoice belongs to the store goods
 * were delivered to, not just the org.
 *
 * `contentHash` is indexed, deliberately NOT unique: duplicate detection is a
 * validation-gate outcome that routes a document to review, not a database constraint that blocks
 * the insert outright — a legitimate re-upload of the exact same file (e.g. re-scanning after a
 * failed extraction) must still be allowed to exist as its own row.
 *
 * `classificationConfidence`: the model's own subjective confidence in `type`, nullable —
 * distinct from a real `0` (genuinely no confidence) and from "classification never ran" (still
 * `OTHER` from upload-time, no confidence recorded at all).
 */
export const documents = pgTable(
  'documents',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    type: documentTypeEnum('type').notNull(),
    classificationConfidence: numeric('classification_confidence', { precision: 5, scale: 4 }),
    source: documentSourceEnum('source').notNull(),
    status: documentStatusEnum('status').notNull().default('UPLOADED'),
    storageKey: text('storage_key').notNull(),
    contentHash: text('content_hash').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    version: integer('version').notNull().default(1),
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => documents.id),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id),
    // Nullable: a single ad-hoc upload (the pre-existing /documents drop-zone, still fully
    // supported) has no batch at all — this column is purely additive, 012-02's own scope.
    uploadBatchId: uuid('upload_batch_id').references(() => documentUploadBatches.id),
    ...timestamps,
    ...softDelete,
  }
);

/**
 * One extraction run over a document. Kept separate from `documents` (rather than columns on it)
 * because a document can be re-extracted with a better model — the database plan names
 * this table directly as needing full-snapshot history, "for measuring whether accuracy is
 * improving." `fields`/`lines`/`validation` match the plan Phase 1's shapes exactly.
 *
 * `fields` entries carry a `bbox` key in their JSONB shape per the design — but ADR-13 (the
 * provider decision) confirms the chosen provider, Gemini vision, does not return bounding boxes.
 * That key is structurally present in the shape and will be absent/null in every real row until a
 * provider that supports it is added; the review UI must not assume it's populated.
 *
 * `organizationId` is denormalized here directly, not looked up via a join to `documents` — same
 * convention `sales_transaction_lines` already established: every table `TenantScopedRepository`
 * guards needs its own real `organization_id` column, so the app-layer tenant predicate doesn't
 * depend on a join succeeding.
 */
export const documentExtractions = pgTable('document_extractions', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  provider: text('provider').notNull(),
  modelVersion: text('model_version').notNull(),
  promptVersion: text('prompt_version').notNull(),
  fields: jsonb('fields').notNull(), // { [fieldName]: { value, confidence, bbox? } }
  lines: jsonb('lines').notNull(), // [{ description, sku, qty, unit, price, total, confidence }]
  validation: jsonb('validation').notNull(), // ValidationResult — issues[], canAutoApprove
  overallConfidence: numeric('overall_confidence', { precision: 5, scale: 4 }),
  extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * one row per document, embedding a synthetic descriptive text assembled
 * from its already-approved extracted fields (`buildDocumentEmbeddingText`, `@retailos/domain`) —
 * no raw OCR full-text is persisted anywhere in this schema (confirmed with the user before
 * building this), so this is the real, honest corpus. `embedding` is declared via the `vector`
 * customType (migration `0042_document_embeddings.sql`) — application code never reads/writes it
 * through Drizzle's typed builder (raw `sql` handles every real write/similarity query, since
 * pgvector's operators have no builder representation either); it's declared here purely so
 * `drizzle-kit`'s own schema introspection stays aware of the column. `documentId` is UNIQUE — one
 * embedding per document, re-generated (not appended) on re-approval.
 */
export const documentEmbeddings = pgTable('document_embeddings', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  model: text('model').notNull(),
  sourceText: text('source_text').notNull(),
  embedding: vector('embedding', 768).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentChunkTypeEnum = pgEnum('document_chunk_type', ['header', 'line_item']);

/**
 * the PER-CHUNK half of document embeddings, deliberately separate from
 * `document_embeddings` above rather than replacing it: `document_embeddings` is ONE row per whole
 * document, serving `search.documents`' document-LIST UI where a title/subtitle per
 * document is the right granularity; the assistant's retrieval stage (this task) needs
 * chunk-granularity passages with real, citable snippet text — "never split a line item" (spec
 * 10's own words) is meaningless at whole-document granularity. Both tables stay real, both get
 * real writes from the same approval event, matching a document having two genuinely different
 * consumers rather than one consumer being asked to serve a granularity it wasn't designed for.
 *
 * `chunkKey` (`'header'` or `'line-{index}'`, from `chunkDocument`, `@retailos/domain`) plus a
 * UNIQUE `(document_id, chunk_key)` index makes re-chunking a re-approved document idempotent by
 * upsert rather than delete-then-insert — a corrected line 2 gets its own chunk re-embedded in
 * place, not the whole document's chunk set torn down and rebuilt (which would needlessly
 * re-embed every UNCHANGED line too, real cost under this project's free-tier quota constraint).
 */
export const documentChunkEmbeddings = pgTable(
  'document_chunk_embeddings',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    chunkKey: text('chunk_key').notNull(),
    chunkType: documentChunkTypeEnum('chunk_type').notNull(),
    chunkOrder: integer('chunk_order').notNull(),
    model: text('model').notNull(),
    sourceText: text('source_text').notNull(),
    embedding: vector('embedding', 768).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('document_chunk_embeddings_document_chunk_key_unique').on(table.documentId, table.chunkKey)]
);

/**
 * Every human correction to an extracted field, permanent — feeds
 * two downstream consumers: supplier-SKU → product mappings become permanent rows (
 * deterministic learning, I9), and per-supplier/per-field correction rate is the accuracy telemetry
 * the accuracy telemetry reads (accuracy targets are measured this way). `fieldPath` is a
 * dotted/bracket path into the extraction's `fields`/`lines` JSONB (e.g. `lines[2].unitPrice`), not
 * a foreign key — the shape it points into is itself schemaless JSONB. `organizationId` is
 * denormalized directly, same reasoning as `document_extractions`.
 */
export const extractionCorrections = pgTable('extraction_corrections', {
  id: idColumn(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  extractionId: uuid('extraction_id')
    .notNull()
    .references(() => documentExtractions.id),
  fieldPath: text('field_path').notNull(),
  originalValue: jsonb('original_value'),
  correctedValue: jsonb('corrected_value'),
  correctedByUserId: uuid('corrected_by_user_id')
    .notNull()
    .references(() => users.id),
  correctedAt: timestamp('corrected_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Provenance: connects a document to every entity it produced or affected (the design — "enables
 * drill-through from any number to its source"). Polymorphic `entityType`/`entityId`, the same shape
 * `audit_logs` already established for the identical problem (a generic reference to a row in any
 * one of several unrelated tables) — no FK is possible across a polymorphic reference, so this
 * table is the one place in the schema where entity identity is trusted by convention, not
 * constraint, matching `audit_logs`' own precedent exactly. `relationship` names what the document
 * did to that entity (e.g. `PRICE_SOURCE`, `STOCK_RECEIPT`, `MATCH_SOURCE`) — the posting
 * engine is the only writer. `organizationId` is denormalized directly, same reasoning as
 * `document_extractions`.
 */
export const documentLinks = pgTable(
  'document_links',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    relationship: text('relationship').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('document_links_document_entity_relationship_idx').on(table.documentId, table.entityType, table.entityId, table.relationship)]
);
