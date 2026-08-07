import { describe, expect, it } from 'vitest';
import { decideDocumentRouting } from './routing';

describe('decideDocumentRouting', () => {
  it('routes to AUTO_APPROVED when gates pass, overall confidence is high, and every field confidence is high', () => {
    const result = decideDocumentRouting(true, { overallConfidence: 0.9, fieldConfidences: [0.85, 0.99, 1] });
    expect(result).toBe('AUTO_APPROVED');
  });

  it('routes to REVIEW_REQUIRED when a gate failed, regardless of confidence', () => {
    const result = decideDocumentRouting(false, { overallConfidence: 1, fieldConfidences: [1, 1] });
    expect(result).toBe('REVIEW_REQUIRED');
  });

  it('routes to REVIEW_REQUIRED when overall confidence is below the threshold', () => {
    const result = decideDocumentRouting(true, { overallConfidence: 0.84, fieldConfidences: [0.9, 0.9] });
    expect(result).toBe('REVIEW_REQUIRED');
  });

  it('routes to REVIEW_REQUIRED when overall confidence is null (e.g. Tesseract, which has no confidence concept)', () => {
    const result = decideDocumentRouting(true, { overallConfidence: null, fieldConfidences: [] });
    expect(result).toBe('REVIEW_REQUIRED');
  });

  it('routes to REVIEW_REQUIRED when a single field confidence falls below the threshold even though overall confidence is high', () => {
    const result = decideDocumentRouting(true, { overallConfidence: 0.9, fieldConfidences: [0.95, 0.5, 0.95] });
    expect(result).toBe('REVIEW_REQUIRED');
  });

  it('routes to REVIEW_REQUIRED when any field confidence is null, even if every other field is high', () => {
    const result = decideDocumentRouting(true, { overallConfidence: 0.9, fieldConfidences: [0.95, null, 0.95] });
    expect(result).toBe('REVIEW_REQUIRED');
  });

  it('routes to AUTO_APPROVED at exactly the threshold value (0.85 is high enough, not just above it)', () => {
    const result = decideDocumentRouting(true, { overallConfidence: 0.85, fieldConfidences: [0.85] });
    expect(result).toBe('AUTO_APPROVED');
  });

  it('routes to AUTO_APPROVED when there are no fields to score at all (an empty population is vacuously all-high-confidence)', () => {
    const result = decideDocumentRouting(true, { overallConfidence: 0.9, fieldConfidences: [] });
    expect(result).toBe('AUTO_APPROVED');
  });
});
