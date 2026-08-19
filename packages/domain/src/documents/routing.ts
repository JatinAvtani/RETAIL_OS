/**
 * the plan Phase 4: "Auto-approve only when all high-confidence AND all gates pass. Everything else
 * → review queue. An auto-approved wrong document is far worse than a queued one, so bias
 * conservative." `validateExtraction` already decides the gate half (`canAutoApprove`);
 * this is the confidence half, and the AND that combines them.
 *
 * A missing confidence (a field Gemini didn't score, or Tesseract's provider-wide `null` — it has
 * no semantic concept of confidence at all) is treated as failing the threshold, never skipped or
 * defaulted to a pass — I7 applied to a routing decision instead of a number: absence of a
 * confidence signal is not evidence of high confidence.
 */

export type DocumentRoutingDecision = 'AUTO_APPROVED' | 'REVIEW_REQUIRED';

export interface RoutingConfidenceInput {
  /** Provider-level mean confidence, or `null` if the provider has no confidence concept (Tesseract) or extraction failed. */
  overallConfidence: number | null;
  /** Every individual field/line confidence the extraction produced, in whatever order — only the values matter. `null` entries (a field the provider didn't score) count as missing, same as an absent overall confidence. */
  fieldConfidences: (number | null)[];
}

const HIGH_CONFIDENCE_THRESHOLD = 0.85;

const meetsThreshold = (confidence: number | null): boolean => confidence !== null && confidence >= HIGH_CONFIDENCE_THRESHOLD;

/**
 * `canAutoApprove` alone only proves internal consistency — it says nothing about whether
 * the model was actually confident it read the document correctly. Both must hold: every gate
 * passes AND the overall confidence AND every present per-field confidence clears the threshold.
 */
export const decideDocumentRouting = (canAutoApprove: boolean, confidence: RoutingConfidenceInput): DocumentRoutingDecision => {
  if (!canAutoApprove) return 'REVIEW_REQUIRED';
  if (!meetsThreshold(confidence.overallConfidence)) return 'REVIEW_REQUIRED';
  if (!confidence.fieldConfidences.every(meetsThreshold)) return 'REVIEW_REQUIRED';
  return 'AUTO_APPROVED';
};
