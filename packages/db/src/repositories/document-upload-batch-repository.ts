import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateId } from '@retailos/domain';
import * as schema from '../schema/index';
import { documentUploadBatches, documents, type documentStatusEnum } from '../schema/index';
import { TenantScopedRepository } from '../tenant-repository';

type DocumentStatus = (typeof documentStatusEnum.enumValues)[number];

export type BatchProgress = {
  batchId: string;
  expectedCount: number;
  uploadedCount: number;
  countsByStatus: Partial<Record<DocumentStatus, number>>;
};

/**
 * Groups the documents from one bulk-upload session (012-02) so a caller can poll real, scoped
 * progress. Progress is always DERIVED from the real `documents.status` values of the batch's
 * member rows at read time — never a separately maintained counter that could drift from the truth
 * (I2). `uploadedCount` counts documents that have a real row (i.e. `confirmUpload` succeeded for
 * them) — it is deliberately NOT compared against `expectedCount` here; the caller decides how to
 * present "X of Y uploaded, Z processed" from these raw counts.
 */
export class DocumentUploadBatchRepository extends TenantScopedRepository<typeof documentUploadBatches> {
  constructor(db: ReturnType<typeof drizzle<typeof schema>>, organizationId: string) {
    super(db, documentUploadBatches, organizationId);
  }

  async create(input: { storeId: string; expectedCount: number; createdByUserId?: string }): Promise<{ id: string }> {
    const id = generateId();
    await this.runScoped(async (db) => {
      await db.insert(documentUploadBatches).values({
        id,
        organizationId: this.organizationId,
        storeId: input.storeId,
        expectedCount: input.expectedCount,
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
      });
    });
    return { id };
  }

  async findById(id: string) {
    const rows = await this.runScoped((db, scopedWhere) =>
      db.select().from(documentUploadBatches).where(scopedWhere(eq(documentUploadBatches.id, id)))
    );
    return rows[0] ?? null;
  }

  /**
   * `documents` is a DIFFERENT table from this repository's own `documentUploadBatches` — reusing
   * `scopedWhere` here would produce a WHERE clause referencing `document_upload_batches.
   * organization_id` against a query whose FROM clause is `documents`, the exact "scopedWhere bound
   * to the wrong table" class this project's own standing convention warns against. The tenant
   * predicate is built by hand against `documents.organizationId` directly instead.
   */
  async getProgress(batchId: string): Promise<BatchProgress | null> {
    const batch = await this.findById(batchId);
    if (!batch) return null;

    const rows = await this.runScoped((db) =>
      db
        .select({ status: documents.status, count: sql<string>`count(*)` })
        .from(documents)
        .where(sql`${documents.organizationId} = ${this.organizationId} AND ${documents.uploadBatchId} = ${batchId}`)
        .groupBy(documents.status)
    );

    const countsByStatus: Partial<Record<DocumentStatus, number>> = {};
    let uploadedCount = 0;
    for (const row of rows) {
      const count = Number(row.count);
      countsByStatus[row.status] = count;
      uploadedCount += count;
    }

    return {
      batchId,
      expectedCount: batch.expectedCount,
      uploadedCount,
      countsByStatus,
    };
  }
}
