import { decideDocumentRouting } from '@retailos/domain';

/**
 * 007-14 (spec 12 §12.2's `extraction_auto_approval_rate`: "auto-approved / total — measures
 * whether the pipeline saves labor"). Given already-fetched extraction rows (I2's own precedent —
 * `computeRecipeCost`/`computeDataFreshnessLag` never touch a database, `apps/api`'s router does
 * the fetching), pure.
 *
 * Deliberately re-derives the routing decision via `decideDocumentRouting` (007-08's own pure
 * function) from each extraction's STORED `canAutoApprove`/confidence, rather than reading the
 * document's CURRENT `status` column. A human can approve/reject a document AFTER it was
 * auto-approved (plan.md: an auto-approval is "still reviewable"), which moves `documents.status`
 * away from `AUTO_APPROVED` — reading current status would silently undercount the pipeline's own
 * real auto-approval rate by conflating it with a later, unrelated human decision. The extraction
 * row's own `validation.canAutoApprove` and confidence values are the honest, immutable record of
 * what the pipeline itself decided at extraction time.
 */
export interface ExtractionAccuracyInput {
  canAutoApprove: boolean;
  overallConfidence: number | null;
  fieldConfidences: (number | null)[];
}

/** `null` when there is no data at all — an empty period is a genuine "unknown," never a fabricated 0% or 100% (I7). */
export const computeExtractionAutoApprovalRate = (extractions: ExtractionAccuracyInput[]): number | null => {
  if (extractions.length === 0) return null;
  const autoApprovedCount = extractions.filter(
    (e) => decideDocumentRouting(e.canAutoApprove, { overallConfidence: e.overallConfidence, fieldConfidences: e.fieldConfidences }) === 'AUTO_APPROVED'
  ).length;
  return autoApprovedCount / extractions.length;
};

/**
 * Per-gate BLOCK/WARN frequency across a set of extractions' validation results — real data
 * 007-07's gates already produce, no new tracking needed. Answers "which validation gate fires
 * most often," the honest, available slice of "accuracy telemetry" (a true per-SUPPLIER correction
 * rate would need grouping `extraction_corrections` by the extracted supplier name — real but
 * separate data this function doesn't touch).
 */
export interface ValidationIssueCount {
  code: string;
  severity: 'BLOCK' | 'WARN';
  count: number;
}

export const computeValidationIssueFrequency = (
  validations: { issues: { code: string; severity: 'BLOCK' | 'WARN' }[] }[]
): ValidationIssueCount[] => {
  const counts = new Map<string, ValidationIssueCount>();
  for (const validation of validations) {
    for (const issue of validation.issues) {
      const key = `${issue.code}:${issue.severity}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { code: issue.code, severity: issue.severity, count: 1 });
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
};
