import { and, desc, eq, gte, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { auditLogs, documentExtractions, documentLinks, documents, extractionCorrections, outboxEvents, type documentSourceEnum, type documentStatusEnum, type documentTypeEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

export type DocumentType = (typeof documentTypeEnum.enumValues)[number];
export type DocumentSource = (typeof documentSourceEnum.enumValues)[number];
export type DocumentStatus = (typeof documentStatusEnum.enumValues)[number];

/**
 * 007-01's schema-task repository for `documents`/`document_extractions`/`extraction_corrections`/
 * `document_links`. This is link 1 of the costing chain (invoice -> price -> cost -> recipe ->
 * margin) — every write here matters more than most, but this task's own scope is schema plus the
 * minimal operations needed to prove the schema is real and correctly tenant-scoped. Extraction
 * (007-05/06), validation gates (007-07), and posting (007-11) are separate, later tasks; this
 * class does not run OCR, validate arithmetic, or post anything.
 */
export class DocumentRepository extends TenantScopedRepository<typeof documents> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, documents, organizationId);
  }

  /**
   * Records a newly uploaded document. `contentHash` is stored but never checked for uniqueness
   * here — duplicate detection (spec 05 §5.6.3) is a validation-gate decision (007-07), not a
   * database constraint, so the exact same file can legitimately be uploaded twice (e.g. retrying
   * after a failed extraction) and this method must not reject it.
   *
   * `type` defaults to `'OTHER'` — 007-02 (upload) runs before 007-04 (classification) exists, so a
   * freshly uploaded document genuinely has no type yet; guessing INVOICE would be exactly the kind
   * of unearned certainty I7 exists to prevent. 007-04 updates this once real classification lands.
   */
  async create(input: {
    storeId: string;
    type?: DocumentType;
    source: DocumentSource;
    storageKey: string;
    contentHash: string;
    mimeType: string;
    sizeBytes: number;
    supersedesId?: string;
    uploadedByUserId?: string;
  }): Promise<{ id: string }> {
    return this.runScoped(async (db) => {
      const id = generateId();
      await db.insert(documents).values({
        id,
        organizationId: this.organizationId,
        storeId: input.storeId,
        type: input.type ?? 'OTHER',
        source: input.source,
        storageKey: input.storageKey,
        contentHash: input.contentHash,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        ...(input.supersedesId !== undefined ? { supersedesId: input.supersedesId } : {}),
        ...(input.uploadedByUserId !== undefined ? { uploadedByUserId: input.uploadedByUserId } : {}),
      });
      return { id };
    });
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(documents)
        .where(scopedWhere(eq(documents.id, id)))
    );
    return rows[0] ?? null;
  }

  /**
   * Every prior upload sharing this exact content hash, most recent first — the read side of the
   * content-hash duplicate check spec 05 §5.6.3 names. Returns rows, never a boolean or a
   * pre-computed "is duplicate" verdict: that decision belongs to the validation gate (007-07),
   * which also needs to compare supplier + document number, not just the hash, so it must see the
   * candidate rows themselves.
   */
  async findByContentHash(contentHash: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(documents)
        .where(scopedWhere(eq(documents.contentHash, contentHash)))
        .orderBy(desc(documents.createdAt))
    );
  }

  /**
   * 007-07's duplicate gate, second half: a different document (excluded by id) whose LATEST
   * extraction's `fields.supplier.value`/`fields.documentNumber.value` (case-insensitive, exact
   * text match — no fuzzy matching, matching this task's confirmed scope) equals this one's.
   * `documentNumber`/`supplier` are extracted free text, not columns, so this reads
   * `document_extractions.fields` JSONB directly rather than joining on real columns. A document
   * with no extraction yet, or an extraction with a null/unparseable supplier or documentNumber,
   * cannot match anything here — there being no comparable data is a real "unknown," not a
   * fabricated non-match.
   */
  async findBySupplierAndDocumentNumber(excludeDocumentId: string, supplier: string, documentNumber: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .selectDistinctOn([documents.id], { id: documents.id })
        .from(documents)
        .innerJoin(documentExtractions, eq(documentExtractions.documentId, documents.id))
        .where(
          scopedWhere(
            and(
              ne(documents.id, excludeDocumentId),
              eq(sql`lower(${documentExtractions.fields}->'supplier'->>'value')`, supplier.trim().toLowerCase()),
              eq(sql`lower(${documentExtractions.fields}->'documentNumber'->>'value')`, documentNumber.trim().toLowerCase())
            )
          )
        )
    );
  }

  async listByStatus(status: DocumentStatus) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(documents)
        .where(scopedWhere(eq(documents.status, status)))
        .orderBy(desc(documents.createdAt))
    );
  }

  /** Every document for one store, most recent first — the upload page's own "recent uploads" list. */
  async listForStore(storeId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(documents)
        .where(scopedWhere(eq(documents.storeId, storeId)))
        .orderBy(desc(documents.createdAt))
    );
  }

  /**
   * 007-13: the real list/search/filter view — status and type are real column filters; `query`
   * matches against the LATEST extraction's `fields.supplier.value`/`fields.documentNumber.value`
   * (case-insensitive substring), the same JSONB-read pattern 007-07's duplicate gate already
   * established, since supplier/document-number are extracted free text, not real columns on
   * `documents`. A document with no extraction yet (still `UPLOADED`/`PROCESSING`) simply can't
   * match a text query — it's excluded, not a false match, which is the honest behavior (I7: no
   * data to search is not the same as a match).
   */
  async search(
    storeId: string,
    filters: { status?: DocumentStatus; type?: DocumentType; query?: string }
  ) {
    return this.runScoped((db, scopedWhere) => {
      const conditions = [eq(documents.storeId, storeId)];
      if (filters.status) conditions.push(eq(documents.status, filters.status));
      if (filters.type) conditions.push(eq(documents.type, filters.type));

      if (!filters.query || filters.query.trim().length === 0) {
        return db
          .select()
          .from(documents)
          .where(scopedWhere(and(...conditions)))
          .orderBy(desc(documents.createdAt));
      }

      // A subquery (EXISTS), not a JOIN — a document can have MULTIPLE extraction rows
      // (re-extraction preserves history, per 007-01's own design), and a join would either
      // duplicate the document row per matching extraction or require a DISTINCT ON that forces
      // ordering by documents.id first, breaking "most recent first". EXISTS asks the right
      // question directly: "does at least one of this document's extractions match?"
      const needle = `%${filters.query.trim().toLowerCase()}%`;
      const matchesQuery = sql`EXISTS (
        SELECT 1 FROM ${documentExtractions}
        WHERE ${documentExtractions.documentId} = ${documents.id}
          AND (
            lower(${documentExtractions.fields}->'supplier'->>'value') LIKE ${needle}
            OR lower(${documentExtractions.fields}->'documentNumber'->>'value') LIKE ${needle}
          )
      )`;
      return db
        .select()
        .from(documents)
        .where(scopedWhere(and(...conditions, matchesQuery)))
        .orderBy(desc(documents.createdAt));
    });
  }

  async updateStatus(id: string, status: DocumentStatus) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(documents)
        .set({ status, updatedAt: new Date() })
        .where(scopedWhere(eq(documents.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  /**
   * 007-09 (review UI): a reviewer's decision on a document already at `REVIEW_REQUIRED` (or
   * `AUTO_APPROVED`, which plan.md §5.6.1 explicitly calls "still reviewable" — a human can override
   * an auto-approval). Status update, outbox event, and audit log entry all write inside ONE
   * transaction (I8) — matching `MovementService.postMovementInTx`'s established pattern, since
   * composing `updateStatus` with separate outbox/audit inserts from outside would run as multiple
   * transactions, not one atomic unit (the same lesson this codebase has hit repeatedly). Returns
   * `null` (never throws) when the document doesn't exist or isn't in a reviewable state — the
   * caller decides how to surface that, matching every other `returning()`-based method's
   * `rows[0] ?? null` convention in this class.
   */
  async approve(id: string, reviewedByUserId: string) {
    return this.reviewDecision(id, reviewedByUserId, 'APPROVED', 'document.approved');
  }

  /** Same shape as `approve` — a rejected document never posts (007-11's posting engine only ever reads `APPROVED` documents). */
  async reject(id: string, reviewedByUserId: string, reason?: string) {
    return this.reviewDecision(id, reviewedByUserId, 'REJECTED', 'document.rejected', reason);
  }

  private async reviewDecision(
    id: string,
    reviewedByUserId: string,
    status: 'APPROVED' | 'REJECTED',
    eventType: 'document.approved' | 'document.rejected',
    reason?: string
  ) {
    return this.runScoped(async (db, scopedWhere) => {
      const existingRows = await db.select().from(documents).where(scopedWhere(eq(documents.id, id)));
      const existing = existingRows[0];
      if (!existing || (existing.status !== 'REVIEW_REQUIRED' && existing.status !== 'AUTO_APPROVED')) {
        return null;
      }

      const updatedRows = await db
        .update(documents)
        .set({ status, updatedAt: new Date() })
        .where(scopedWhere(eq(documents.id, id)))
        .returning();
      const updated = updatedRows[0];
      if (!updated) return null;

      await db.insert(outboxEvents).values({
        id: generateId(),
        organizationId: this.organizationId,
        aggregateType: 'document',
        aggregateId: id,
        eventType,
        payload: { documentId: id, previousStatus: existing.status, ...(reason !== undefined ? { reason } : {}) },
      });

      await db.insert(auditLogs).values({
        id: generateId(),
        organizationId: this.organizationId,
        actorUserId: reviewedByUserId,
        actorType: 'USER',
        action: status === 'APPROVED' ? 'document.approved' : 'document.rejected',
        entityType: 'document',
        entityId: id,
        metadata: { previousStatus: existing.status, ...(reason !== undefined ? { reason } : {}) },
      });

      return updated;
    });
  }

  /**
   * 007-04: records the result of classification — real confidence when the model call succeeded,
   * `null` confidence when it could not be attempted at all (no API key, provider error, malformed
   * response). Both cases leave `type` as whatever `classifyDocument` returned (`'OTHER'` on
   * failure, matching `create`'s own pre-classification default) — this method never guesses a
   * type itself, only persists one already decided by the caller.
   */
  async updateClassification(id: string, type: DocumentType, confidence: string | null) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db
        .update(documents)
        .set({ type, classificationConfidence: confidence, updatedAt: new Date() })
        .where(scopedWhere(eq(documents.id, id)))
        .returning()
    );
    return rows[0] ?? null;
  }

  /**
   * Records one extraction run. `organizationId` is denormalized onto `document_extractions`
   * directly (see schema comment) — `documentId` is trusted to belong to this same organization
   * because it can only have been obtained via this repository's own org-scoped `findById`/`create`.
   */
  async recordExtraction(input: {
    documentId: string;
    provider: string;
    modelVersion: string;
    promptVersion: string;
    fields: unknown;
    lines: unknown;
    validation: unknown;
    overallConfidence?: string;
  }): Promise<{ id: string }> {
    return this.runScoped(async (db) => {
      const id = generateId();
      await db.insert(documentExtractions).values({
        id,
        organizationId: this.organizationId,
        documentId: input.documentId,
        provider: input.provider,
        modelVersion: input.modelVersion,
        promptVersion: input.promptVersion,
        fields: input.fields,
        lines: input.lines,
        validation: input.validation,
        ...(input.overallConfidence !== undefined ? { overallConfidence: input.overallConfidence } : {}),
      });
      return { id };
    });
  }

  /** Most recent extraction for a document — re-extraction (a better model, a retry) adds a new row rather than overwriting, so "latest" is a query, not a fact stored on `documents` itself. */
  async getLatestExtraction(documentId: string) {
    const rows = await this.runScoped((db) =>
      db
        .select()
        .from(documentExtractions)
        .where(and(eq(documentExtractions.organizationId, this.organizationId), eq(documentExtractions.documentId, documentId)))
        .orderBy(desc(documentExtractions.extractedAt))
        .limit(1)
    );
    return rows[0] ?? null;
  }

  /**
   * 007-14: every extraction across the whole organization since `since` — org-wide, not
   * store-scoped, matching `integrations.health`'s own precedent (006-13) that accuracy telemetry
   * is a tenant-level view, not a per-store one. Feeds `computeExtractionAutoApprovalRate`/
   * `computeValidationIssueFrequency` (packages/metrics) — this method only fetches raw rows, never
   * computes the rate itself (I2).
   */
  async listExtractionsSince(since: Date) {
    return this.runScoped((db) =>
      db
        .select()
        .from(documentExtractions)
        .where(and(eq(documentExtractions.organizationId, this.organizationId), gte(documentExtractions.extractedAt, since)))
        .orderBy(desc(documentExtractions.extractedAt))
    );
  }

  async recordCorrection(input: {
    extractionId: string;
    fieldPath: string;
    originalValue: unknown;
    correctedValue: unknown;
    correctedByUserId: string;
  }): Promise<{ id: string }> {
    return this.runScoped(async (db) => {
      const id = generateId();
      await db.insert(extractionCorrections).values({
        id,
        organizationId: this.organizationId,
        extractionId: input.extractionId,
        fieldPath: input.fieldPath,
        originalValue: input.originalValue,
        correctedValue: input.correctedValue,
        correctedByUserId: input.correctedByUserId,
      });
      return { id };
    });
  }

  /**
   * Provenance (spec 07 §7.6): links a document to an entity it produced or affected. Idempotent on
   * `(documentId, entityType, entityId, relationship)` — the posting engine (007-11) that will call
   * this runs inside one transaction with all-or-nothing semantics, but re-running a retried posting
   * attempt must not create duplicate provenance rows for the same fact.
   */
  async addLink(input: { documentId: string; entityType: string; entityId: string; relationship: string }): Promise<{ id: string } | { status: 'duplicate' }> {
    return this.runScoped(async (db) => {
      const id = generateId();
      const inserted = await db
        .insert(documentLinks)
        .values({
          id,
          organizationId: this.organizationId,
          documentId: input.documentId,
          entityType: input.entityType,
          entityId: input.entityId,
          relationship: input.relationship,
        })
        .onConflictDoNothing({
          target: [documentLinks.documentId, documentLinks.entityType, documentLinks.entityId, documentLinks.relationship],
        })
        .returning();
      const created = inserted[0];
      if (!created) {
        return { status: 'duplicate' };
      }
      return { id: created.id };
    });
  }

  /** Every entity a document produced or affected — the drill-through read (spec 07 §7.6: "enables drill-through from any number to its source"). */
  async findLinksForDocument(documentId: string) {
    return this.runScoped((db) =>
      db
        .select()
        .from(documentLinks)
        .where(and(eq(documentLinks.organizationId, this.organizationId), eq(documentLinks.documentId, documentId)))
    );
  }
}
