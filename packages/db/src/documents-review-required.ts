import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type DocumentReviewRequiredRow = {
  organizationId: string;
  storeId: string;
  documentId: string;
  /** The document's real classified type (e.g. `INVOICE`) — used only for a readable label, never a threshold. */
  type: string;
  /** How long this document has been sitting at REVIEW_REQUIRED — the real signal a manager acts on ("this invoice has been waiting 3 days"), not just the raw fact that it exists. */
  waitingSinceCreatedAt: string;
};

/**
 * `document_review_required`'s real detection — a plain `WHERE status = 'REVIEW_REQUIRED'` on the
 * real `documents` table, the exact same status value `decideDocumentRouting` (`packages/domain`)
 * already writes when a document's confidence/validation gates don't clear the auto-approval bar.
 * No new definition of "needs review" is introduced here (I2) — this only reports which documents
 * already carry that real, existing status.
 *
 * Deliberately cross-tenant by nature, same reasoning as `findNegativeStock`/`findExpiryQueue` — an
 * internal sweep across every tenant, not a single organization's scoped request. `db` must be an
 * admin-equivalent connection.
 */
export const findDocumentsReviewRequired = async (db: Db): Promise<DocumentReviewRequiredRow[]> => {
  const rows = await db.execute<{
    organization_id: string;
    store_id: string;
    document_id: string;
    type: string;
    created_at: string;
  }>(sql`
    SELECT
      organization_id,
      store_id,
      id AS document_id,
      type,
      created_at
    FROM documents
    WHERE status = 'REVIEW_REQUIRED'
      AND deleted_at IS NULL
  `);

  return rows.map((row) => ({
    organizationId: row.organization_id,
    storeId: row.store_id,
    documentId: row.document_id,
    type: row.type,
    waitingSinceCreatedAt: row.created_at,
  }));
};
