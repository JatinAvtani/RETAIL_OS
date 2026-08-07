import { describe, expect, it } from 'vitest';
import { computeExtractionAutoApprovalRate, computeValidationIssueFrequency } from './extraction-accuracy';

describe('computeExtractionAutoApprovalRate', () => {
  it('returns null for an empty period — no data is a genuine unknown, never a fabricated rate (I7)', () => {
    expect(computeExtractionAutoApprovalRate([])).toBeNull();
  });

  it('a fully-mapped, gate-passing, high-confidence extraction counts as auto-approved', () => {
    const rate = computeExtractionAutoApprovalRate([
      { canAutoApprove: true, overallConfidence: 0.9, fieldConfidences: [0.9, 0.95] },
    ]);
    expect(rate).toBe(1);
  });

  it('a failed validation gate never counts as auto-approved regardless of confidence', () => {
    const rate = computeExtractionAutoApprovalRate([
      { canAutoApprove: false, overallConfidence: 1, fieldConfidences: [1, 1] },
    ]);
    expect(rate).toBe(0);
  });

  it('low confidence never counts as auto-approved even when gates pass', () => {
    const rate = computeExtractionAutoApprovalRate([
      { canAutoApprove: true, overallConfidence: 0.5, fieldConfidences: [0.9] },
    ]);
    expect(rate).toBe(0);
  });

  it('computes the real fraction across a mixed set, exactly', () => {
    const rate = computeExtractionAutoApprovalRate([
      { canAutoApprove: true, overallConfidence: 0.9, fieldConfidences: [0.9] }, // auto-approved
      { canAutoApprove: true, overallConfidence: 0.9, fieldConfidences: [0.9] }, // auto-approved
      { canAutoApprove: false, overallConfidence: 0.9, fieldConfidences: [0.9] }, // gate failed
      { canAutoApprove: true, overallConfidence: null, fieldConfidences: [] }, // no confidence
    ]);
    expect(rate).toBe(0.5); // 2 of 4
  });

  it('re-derives the routing decision from the extraction\'s own stored data, not a mutable current status — this is the whole point of the function', () => {
    // This documents the design decision directly: two extractions with IDENTICAL stored
    // canAutoApprove/confidence data always produce the identical routing verdict, regardless of
    // whatever a human did to the document afterward (which this function never sees at all, by
    // design — it only receives extraction-level data, never a documents.status column).
    const rateA = computeExtractionAutoApprovalRate([{ canAutoApprove: true, overallConfidence: 0.9, fieldConfidences: [0.9] }]);
    const rateB = computeExtractionAutoApprovalRate([{ canAutoApprove: true, overallConfidence: 0.9, fieldConfidences: [0.9] }]);
    expect(rateA).toBe(rateB);
  });
});

describe('computeValidationIssueFrequency', () => {
  it('returns an empty array for no validations', () => {
    expect(computeValidationIssueFrequency([])).toEqual([]);
  });

  it('counts each distinct (code, severity) pair across all extractions', () => {
    const result = computeValidationIssueFrequency([
      { issues: [{ code: 'PRICE_ANOMALY', severity: 'BLOCK' }] },
      { issues: [{ code: 'PRICE_ANOMALY', severity: 'BLOCK' }, { code: 'DATE_IMPLAUSIBLE', severity: 'WARN' }] },
      { issues: [] },
    ]);
    expect(result).toEqual([
      { code: 'PRICE_ANOMALY', severity: 'BLOCK', count: 2 },
      { code: 'DATE_IMPLAUSIBLE', severity: 'WARN', count: 1 },
    ]);
  });

  it('sorts by count descending, most frequent first', () => {
    const result = computeValidationIssueFrequency([
      { issues: [{ code: 'DATE_IMPLAUSIBLE', severity: 'WARN' }] },
      { issues: [{ code: 'LINE_ARITHMETIC', severity: 'BLOCK' }] },
      { issues: [{ code: 'LINE_ARITHMETIC', severity: 'BLOCK' }] },
      { issues: [{ code: 'LINE_ARITHMETIC', severity: 'BLOCK' }] },
    ]);
    expect(result[0]).toEqual({ code: 'LINE_ARITHMETIC', severity: 'BLOCK', count: 3 });
    expect(result[1]).toEqual({ code: 'DATE_IMPLAUSIBLE', severity: 'WARN', count: 1 });
  });

  it('the same code at different severities is counted separately — BLOCK and WARN are distinct facts', () => {
    const result = computeValidationIssueFrequency([
      { issues: [{ code: 'DUPLICATE', severity: 'BLOCK' }] },
    ]);
    expect(result).toEqual([{ code: 'DUPLICATE', severity: 'BLOCK', count: 1 }]);
  });
});
