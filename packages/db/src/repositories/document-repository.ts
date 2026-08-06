import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { documentExtractions, documentLinks, documents, extractionCorrections, type documentSourceEnum, type documentStatusEnum, type documentTypeEnum } from '../schema/index';
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

  async listByStatus(status: DocumentStatus) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(documents)
        .where(scopedWhere(eq(documents.status, status)))
        .orderBy(desc(documents.createdAt))
    );
  }

  /** Every document for one store, most recent first — the upload page's own "recent uploads" list (007-13's fuller search/filter view is a separate, later task). */
  async listForStore(storeId: string) {
    return this.runScoped((db, scopedWhere) =>
      db
        .select()
        .from(documents)
        .where(scopedWhere(eq(documents.storeId, storeId)))
        .orderBy(desc(documents.createdAt))
    );
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
