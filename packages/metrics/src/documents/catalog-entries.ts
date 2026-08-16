import { z } from 'zod';
import { DocumentRepository } from '@retailos/db';
import { defineMetric, type MetricContext, type MetricResult } from '../catalog/index.js';
import { computeExtractionAutoApprovalRate, type ExtractionAccuracyInput } from './extraction-accuracy.js';

/**
 * Operational health metrics for the document pipeline (spec 12 §H, `009-10`).
 * `extraction_auto_approval_rate` was already a pure, tested function (007-14) with zero catalog
 * registration — pure wrapper work, matching 009-09's precedent for pre-existing compute logic.
 * `documents_pending_review` is genuinely new: `DocumentRepository.listByStatus('REVIEW_REQUIRED')`
 * already exists, but nothing previously computed each document's pending AGE. `updatedAt` is used
 * as "time entered REVIEW_REQUIRED" — an honest proxy, not a purpose-built column (no dedicated
 * status-history table exists), since `DocumentRepository.updateStatus`/`reviewDecision` set
 * `updatedAt` on every status transition and nothing in this codebase currently updates a document
 * row for an unrelated reason.
 */

const storeParams = z.object({ storeId: z.string().uuid() });
type StoreParams = z.infer<typeof storeParams>;

const orgParams = z.object({});
type OrgParams = z.infer<typeof orgParams>;

/* ------------------------------------------------------------------ documents_pending_review */

export const documentsPendingReviewMetric = defineMetric<StoreParams>({
  id: 'documents_pending_review',
  description: 'Count of documents awaiting human review, and the age of the oldest one — the review backlog.',
  parameters: storeParams,
  unit: 'COUNT',
  requiredPermission: 'documents:read',
  sources: ['documents'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const documentRepository = new DocumentRepository(ctx.db, ctx.organizationId);
    const rows = await documentRepository.listByStatus('REVIEW_REQUIRED');
    const storeRows = rows.filter((row) => row.storeId === params.storeId);
    const now = new Date();
    return {
      metricId: 'documents_pending_review',
      value: String(storeRows.length),
      unit: 'COUNT',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'documents', rowCount: storeRows.length }],
    };
  },
});

/**
 * The oldest pending document's age in days — the second half of `documents_pending_review`'s
 * "count + age" spec definition. Kept as a SEPARATE metric id rather than a second field bolted
 * onto the count, matching the catalog's fixed one-scalar-`value`-per-call `MetricResult` contract
 * (the same constraint that forced `waste_by_reason`/`spend_by_category` into one-call-per-dimension
 * shapes rather than a breakdown array).
 */
export const documentsPendingReviewOldestAgeMetric = defineMetric<StoreParams>({
  id: 'documents_pending_review_oldest_age_days',
  description: 'Age in days of the oldest document still awaiting human review — how stale the backlog has gotten.',
  parameters: storeParams,
  unit: 'DAYS',
  requiredPermission: 'documents:read',
  sources: ['documents'],
  async execute(params, ctx: MetricContext): Promise<MetricResult> {
    const documentRepository = new DocumentRepository(ctx.db, ctx.organizationId);
    const rows = await documentRepository.listByStatus('REVIEW_REQUIRED');
    const storeRows = rows.filter((row) => row.storeId === params.storeId);
    const now = new Date();
    if (storeRows.length === 0) {
      return {
        metricId: 'documents_pending_review_oldest_age_days',
        value: 'unknown',
        unit: 'DAYS',
        period: { from: now, to: now },
        computedAt: now,
        freshness: now,
        provenance: [{ table: 'documents', rowCount: 0 }],
        unknownReason: 'No documents are currently awaiting review.',
      };
    }
    const oldestUpdatedAt = storeRows.reduce(
      (oldest, row) => (row.updatedAt < oldest ? row.updatedAt : oldest),
      storeRows[0]!.updatedAt
    );
    const ageDays = Math.max(0, (now.getTime() - oldestUpdatedAt.getTime()) / (24 * 60 * 60 * 1000));
    return {
      metricId: 'documents_pending_review_oldest_age_days',
      value: ageDays.toFixed(2),
      unit: 'DAYS',
      period: { from: now, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'documents', rowCount: storeRows.length }],
    };
  },
});

/* ------------------------------------------------------------------ extraction_auto_approval_rate */

export const extractionAutoApprovalRateMetric = defineMetric<OrgParams>({
  id: 'extraction_auto_approval_rate',
  description: 'Share of document extractions the pipeline auto-approved without human review — measures labor saved.',
  parameters: orgParams,
  unit: 'PERCENTAGE',
  requiredPermission: 'documents:read',
  sources: ['document_extractions'],
  async execute(_params, ctx: MetricContext): Promise<MetricResult> {
    const documentRepository = new DocumentRepository(ctx.db, ctx.organizationId);
    const since = new Date(0);
    const extractions = await documentRepository.listExtractionsSince(since);
    const inputs: ExtractionAccuracyInput[] = extractions.map((e) => {
      const validation = e.validation as { canAutoApprove: boolean };
      return {
        canAutoApprove: validation.canAutoApprove,
        overallConfidence: e.overallConfidence !== null ? Number(e.overallConfidence) : null,
        fieldConfidences: collectFieldConfidences(
          e.fields as ExtractedFieldsShape | null,
          e.lines as ExtractedFieldsShape[] | null
        ),
      };
    });
    const rate = computeExtractionAutoApprovalRate(inputs);
    const now = new Date();
    return {
      metricId: 'extraction_auto_approval_rate',
      value: rate === null ? 'unknown' : (rate * 100).toFixed(2),
      unit: 'PERCENTAGE',
      period: { from: since, to: now },
      computedAt: now,
      freshness: now,
      provenance: [{ table: 'document_extractions', rowCount: extractions.length }],
      ...(rate === null ? { unknownReason: 'No document extractions exist yet.' } : {}),
    };
  },
});

type ExtractedFieldsShape = Record<string, { confidence: number | null }>;

/** Mirrors `apps/api/src/trpc/routers/documents.ts`'s own `collectFieldConfidences` exactly — every scored field across the document header and every line. */
const collectFieldConfidences = (fields: ExtractedFieldsShape | null, lines: ExtractedFieldsShape[] | null): (number | null)[] => {
  if (fields === null) return [];
  const headerConfidences = Object.values(fields).map((field) => field.confidence);
  const lineConfidences = (lines ?? []).flatMap((line) => Object.values(line).map((field) => field.confidence));
  return [...headerConfidences, ...lineConfidences];
};
